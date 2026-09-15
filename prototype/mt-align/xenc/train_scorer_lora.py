#!/usr/bin/env python3
"""
判别式打分器的正训法：LoRA + **组内 softmax 打分目标**（不是语言模型 loss）。

【原型代码，不是生产实现】

与前面两条路的区别：
  · 0.5B + LM loss：让模型「生成」一个序号 → 目标不匹配，48.8%
  · 冻结特征 + 线性头：编码器没为「比较」训练过 → 45%（且不稳），不够
  · 本脚本：同一题的 K 个义项一起打分、softmax 交叉熵、argmax 出答案 →
    编码器（LoRA）和打分头**一起**朝「把正确义项排到第一」优化

推理时每个义项一次前向、取 argmax：**结构上不可能输出非法序号**。

用法：python train_scorer_lora.py [items.jsonl] [epochs] [lora_layers] [lr]
"""

import json
import sys
import time

import mlx.core as mx
import mlx.nn as nn
import numpy as np
from mlx.optimizers import AdamW
from mlx.utils import tree_flatten
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers

MODEL_ID = "mlx-community/Qwen2.5-0.5B-Instruct-bf16"
MAX_TOKENS = 160


def build_text(item, sense):
    """若样本带 context（上一句），把它也写进查询——用来验证「消歧需要上下文」。"""
    context = item.get("context") or ""
    prefix = f"上一句：{context}\n" if context else ""
    return f"{prefix}单词：{item['word']}　句子：{item['sentence']}\n义项：{sense}"


class Scorer(nn.Module):
    """编码器（含 LoRA）+ 打分头；一题一次前向喂 K 个义项。"""

    def __init__(self, encoder, dim):
        super().__init__()
        self.encoder = encoder
        self.head = nn.Linear(dim, 1)

    def __call__(self, batch_ids):
        hidden = self.encoder(mx.array(batch_ids))  # (K, T, D)
        last = hidden[:, -1, :]  # 取最后一个 token 的隐状态
        return self.head(last).squeeze(-1)  # (K,)


def encode_batch(tokenizer, item):
    senses = item["shuffledSenses"]
    ids = [tokenizer.encode(build_text(item, s))[-MAX_TOKENS:] for s in senses]
    width = max(len(x) for x in ids)
    padded = [x + [0] * (width - len(x)) for x in ids]  # 右侧 pad（只取最后 token，左侧对齐更稳）
    return padded, len(senses), item["target"] - 1


def loss_fn(scorer, batch_ids, target):
    scores = scorer(batch_ids)
    return nn.losses.cross_entropy(scores[None, :], mx.array([target])).mean()


def evaluate(scorer, tokenizer, items):
    correct = 0
    started = time.time()
    for item in items:
        ids, _, target = encode_batch(tokenizer, item)
        scores = scorer(ids)
        mx.eval(scores)
        if int(mx.argmax(scores).item()) == target:
            correct += 1
    return correct / len(items), correct, len(items), time.time() - started


def main() -> int:
    # 位置参数前先剔掉 --flag，否则 `--out=...` 会被当成第 6 个参数 cap 去 int() 而崩
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    data = argv[0] if len(argv) > 0 else "prototype/mt-align/dataset-v2/items.jsonl"
    epochs = int(argv[1]) if len(argv) > 1 else 2
    lora_layers = int(argv[2]) if len(argv) > 2 else 8
    lr = float(argv[3]) if len(argv) > 3 else 1e-5

    # 输出路径可指定：不同数据集（v2 单句 / v3 带上下文）的适配器不能互相覆盖
    out_path = "prototype/mt-align/xenc/scorer.safetensors"
    for arg in sys.argv:
        if arg.startswith("--out="):
            out_path = arg.split("=", 1)[1]

    items = []
    with open(data, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    train = [i for i in items if not i.get("isVal")]
    valid = [i for i in items if i.get("isVal")]
    if len(argv) > 4:  # 冒烟用：只取少量
        cap = int(argv[4])
        train, valid = train[:cap], valid[:cap]

    print(f"加载 {MODEL_ID}：train {len(train)} / valid {len(valid)}", flush=True)
    model, tokenizer = load(MODEL_ID)
    model = dequantize_to_bf16(model)  # 4bit 权重无法求梯度，反量化成 bf16
    model.freeze()
    linear_to_lora_layers(model.model, lora_layers, {"rank": 8, "scale": 20.0, "dropout": 0.0})
    # 取隐状态维度
    probe_ids, _, _ = encode_batch(tokenizer, train[0])
    dim = model.model(mx.array(probe_ids)).shape[-1]
    scorer = Scorer(model.model, dim)
    # 注意：**不要**对 encoder 调 unfreeze()——那是递归解冻，会把整个 0.5B 都变成可训练
    # （实测 100% 可训练，而且量化权重还会报 QuantizedMatmul::vjp 无梯度）。
    # 正确做法：先 freeze 基座，再插 LoRA（新参数默认 trainable），只让 LoRA + 打分头可训。
    trainable = sum(p.size for _, p in tree_flatten(scorer.trainable_parameters()))
    total = sum(p.size for _, p in tree_flatten(scorer.parameters()))
    print(f"隐状态维度 {dim}；可训练 {trainable/1e6:.2f}M / 共 {total/1e6:.1f}M（{trainable/total*100:.2f}%）", flush=True)

    optimizer = AdamW(learning_rate=lr)
    value_and_grad = nn.value_and_grad(scorer, loss_fn)

    best = 0.0
    for epoch in range(epochs):
        running = 0.0
        started = time.time()
        for step, item in enumerate(train):
            ids, _, target = encode_batch(tokenizer, item)
            loss, grads = value_and_grad(scorer, ids, target)
            optimizer.update(scorer, grads)
            mx.eval(scorer.parameters(), optimizer.state)
            running += float(loss)
            if (step + 1) % 100 == 0:
                print(f"  epoch {epoch+1} step {step+1}/{len(train)} loss {running/(step+1):.4f} {time.time()-started:.0f}s", flush=True)
        acc, correct, total_n, seconds = evaluate(scorer, tokenizer, valid)
        print(f"epoch {epoch+1}: train loss {running/len(train):.4f} | valid {correct}/{total_n} = {acc*100:.1f}% | {seconds:.0f}s", flush=True)
        if acc > best:
            best = acc
            # 只存**可训练**参数（LoRA + 打分头 ≈ 6MB）。
            # 用 save_weights() 会把整个 0.5B 编码器也存下来 —— 实测产出 994MB，
            # 那不是"适配器"而是模型副本。
            mx.save_safetensors(out_path, dict(tree_flatten(scorer.trainable_parameters())))

    print(f"\n最佳验证准确率 {best*100:.1f}%")
    print(f"适配器 → {out_path}")
    print("对照：随机 30.8% / 0.5B+LM loss（生成式）48.8% / 冻结特征线性头 45.1%")
    return 0


# ------------------------------------------------------------------
# 兜底：把本地 4bit 权重反量化成 bf16，这样不依赖额外下载
# （MLX 不能对 QuantizedMatmul 求梯度：QuantizedMatmul::vjp 会直接报错）
# ------------------------------------------------------------------
def dequantize_to_bf16(model):
    """把树里的 QuantizedLinear 换成等价的 nn.Linear（bf16）。

    要点：用 named_modules() 拿到全部嵌套路径（leaf_modules() 不递归，
    自己写 children() 递归也漏掉了 model.layers 里的层），
    再一次性 update_modules 替换。
    """
    import mlx.nn as mxnn

    named = dict(model.named_modules())
    quantized = [p for p, m in named.items() if isinstance(m, mxnn.QuantizedLinear)]
    if not quantized:
        # 权重本来就是 bf16（这是推荐路径），无需反量化
        print("权重已是非量化版本，跳过反量化", flush=True)
        return model
    replacements = {}
    for path, module in named.items():
        if not isinstance(module, mxnn.QuantizedLinear):
            continue
        weight = mx.dequantize(
            module.weight, module.scales, module.biases, module.group_size, module.bits
        ).astype(mx.bfloat16)
        bias = getattr(module, "bias", None)
        linear = mxnn.Linear(weight.shape[1], weight.shape[0], bias=bias is not None)
        linear.weight = weight
        if bias is not None:
            linear.bias = bias.astype(mx.bfloat16)
        replacements[path] = linear
    model.update_modules(replacements, strict=False)
    remaining = [p for p, m in model.named_modules() if isinstance(m, mxnn.QuantizedLinear)]
    if remaining:
        raise SystemExit(f"反量化没覆盖全，仍有 {len(remaining)} 个量化层：{remaining[:3]}")
    print(f"反量化完成：{len(replacements)} 个线性层 → bf16", flush=True)
    return model


if __name__ == "__main__":
    raise SystemExit(main())
