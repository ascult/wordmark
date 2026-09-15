#!/usr/bin/env python3
"""
在冻结编码器的特征上训练判别式打分头（组内 softmax）。

【原型代码，不是生产实现】

结构：score(sentence, word, sense) = w · h + b，h 是冻结编码器给出的隐状态。
同一题的 K 个义项一起做 softmax 交叉熵 —— 训练目标就是「把正确义项排到第一」。
推理取 argmax，**结构上不可能输出非法序号**。

用 numpy 手写 SGD：特征已缓存，参数量只有 896+1，根本不需要框架。
（真正要端到端微调编码器时再用 torch/MLX autograd。）

用法：python train_head.py [features.npz] [epochs] [lr]
"""

import sys

import numpy as np


def group_softmax_grads(features, sizes, targets, w, b):
    """返回 (loss, grad_w, grad_b)。组内 softmax，逐题累积。"""
    scores = features @ w + b  # (N,)
    offset = 0
    total_loss = 0.0
    grad_w = np.zeros_like(w)
    grad_b = 0.0
    for size, target in zip(sizes, targets):
        chunk = scores[offset : offset + size]
        offset += size
        shifted = chunk - chunk.max()
        exp = np.exp(shifted)
        prob = exp / exp.sum()
        total_loss += -np.log(max(prob[target], 1e-9))
        # dL/dscore：正确项为 p-1，其余为 p
        grad_scores = prob.copy()
        grad_scores[target] -= 1.0
        block = features[offset - size : offset]
        grad_w += block.T @ grad_scores
        grad_b += grad_scores.sum()
    return total_loss / len(sizes), grad_w / len(sizes), grad_b / len(sizes)


def accuracy(features, sizes, targets, w, b):
    scores = features @ w + b
    offset = 0
    correct = 0
    for size, target in zip(sizes, targets):
        chunk = scores[offset : offset + size]
        offset += size
        if int(np.argmax(chunk)) == int(target):
            correct += 1
    return correct / len(sizes), correct, len(sizes)


def main() -> int:
    path = sys.argv[1] if len(sys.argv) > 1 else "prototype/mt-align/xenc/features.npz"
    epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 60
    lr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.05

    data = np.load(path)
    features = data["features"].astype(np.float32)
    sizes = data["sizes"]
    targets = data["targets"]
    is_val = data["is_val"]

    # 逐题切分：训练题的特征拼在一起，需要按题取回
    def split(mask):
        idx = np.where(mask)[0]
        feats, szs, tgts = [], [], []
        for i in idx:
            start = int(sizes[:i].sum())
            feats.append(features[start : start + int(sizes[i])])
            szs.append(int(sizes[i]))
            tgts.append(int(targets[i]))
        return np.concatenate(feats, axis=0), np.array(szs), np.array(tgts)

    train_x, train_sizes, train_y = split(~is_val)
    val_x, val_sizes, val_y = split(is_val)

    # 标准化：隐状态各维尺度差异极大，不标准化的话裸 SGD 会剧烈震荡
    # （实测准确率在 37%~47% 之间来回跳）
    mu = train_x.mean(axis=0, keepdims=True)
    sd = train_x.std(axis=0, keepdims=True) + 1e-6
    train_x = (train_x - mu) / sd
    val_x = (val_x - mu) / sd

    dim = train_x.shape[1]
    print(f"训练 {len(train_sizes)} 题 / 验证 {len(val_sizes)} 题；特征维度 {dim}（已标准化）")

    rng = np.random.default_rng(0)
    w = np.zeros(dim, dtype=np.float32)
    b = 0.0
    best = 0.0
    weight_decay = 1e-4
    # Adam：之前裸 SGD 要么震荡（lr 大）要么欠拟合（lr 小），换 Adam 才公平
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    m_w = np.zeros_like(w)
    v_w = np.zeros_like(w)
    m_b = 0.0
    v_b = 0.0
    step = 0
    for epoch in range(epochs):
        # mini-batch：按题乱序后分批
        order = rng.permutation(len(train_sizes))
        batch = 64
        batch_x, batch_sizes, batch_y = [], [], []
        for start in range(0, len(order), batch):
            picked = order[start : start + batch]
            bx, bs, by = [], [], []
            cursor = 0
            for i in picked:
                size = train_sizes[i]
                bx.append(train_x[cursor : cursor + size])
                cursor += size
                bs.append(size)
                by.append(train_y[i])
            loss, gw, gb = group_softmax_grads(np.concatenate(bx, axis=0), np.array(bs), np.array(by), w, b)
            step += 1
            gw = gw + weight_decay * w
            m_w = beta1 * m_w + (1 - beta1) * gw
            v_w = beta2 * v_w + (1 - beta2) * gw * gw
            m_b = beta1 * m_b + (1 - beta1) * gb
            v_b = beta2 * v_b + (1 - beta2) * gb * gb
            w -= lr * (m_w / (1 - beta1**step)) / (np.sqrt(v_w / (1 - beta2**step)) + eps)
            b -= lr * (m_b / (1 - beta1**step)) / (np.sqrt(v_b / (1 - beta2**step)) + eps)
        if (epoch + 1) % 25 == 0 or epoch == 0:
            acc, correct, total = accuracy(val_x, val_sizes, val_y, w, b)
            train_acc, tcorrect, ttotal = accuracy(train_x, train_sizes, train_y, w, b)
            print(f"epoch {epoch+1}: loss {loss:.4f} | train {tcorrect}/{ttotal} = {train_acc*100:.1f}% | valid {correct}/{total} = {acc*100:.1f}%", flush=True)
            best = max(best, acc)

    acc, correct, total = accuracy(val_x, val_sizes, val_y, w, b)
    print(f"\n最佳验证准确率 {best*100:.1f}%（最后一次 {correct}/{total} = {acc*100:.1f}%）")
    print("对照：随机 30.8% / 0.5B+LoRA（生成式）48.8%")
    np.savez("prototype/mt-align/xenc/head.npz", w=w, b=np.array(b), mu=mu, sd=sd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
