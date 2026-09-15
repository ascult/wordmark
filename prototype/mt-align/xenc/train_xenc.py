#!/usr/bin/env python3
"""
交叉编码器打分器：把「义项选择」变成「给每个义项打分再取最大」。

【原型代码，不是生产实现】

为什么不继续用自回归小模型（0.5B + LoRA）：
  任务本质是「在 K 个候选里挑一个」，而自回归 LLM 是逐 token 生成一个数字——
  结构上不匹配，还要额外担心它输出非法序号。判别式打分器的结构天然吻合：
    · 输入 (句子+目标词, 义项) → 一个标量分数
    · 同一题的 K 个义项一起做 softmax（交叉熵），训练目标就是「把正确答案排到第一」
    · 推理时取 argmax，**永远不会输出非法序号**
    · 单次前向、无自回归 → 快一到两个数量级，模型也小到几百 MB

用法（在 laptop 的 4070 上跑）：
  venv/bin/python train_xenc.py <数据目录> [epochs] [batch_items] [lr]
"""

import json
import math
import os
import random
import sys
import time

import torch
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_ID = os.environ.get("XENC_MODEL", "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1")
MAX_LEN = 192


def build_query(item):
    """把「哪个词」和「哪句话」都明确写出来——否则同句多词时题目本身有歧义。"""
    return f"单词：{item['word']}　句子：{item['sentence']}"


def build_doc(sense):
    return f"义项：{sense}"


class ChoiceDataset(Dataset):
    """每题 K 个 (query, doc) 对，标签是正确义项的下标。"""

    def __init__(self, items, tokenizer):
        self.items = items
        self.tokenizer = tokenizer

    def __len__(self):
        return len(self.items)

    def __getitem__(self, index):
        item = self.items[index]
        query = build_query(item)
        senses = item["shuffledSenses"]
        encoded = self.tokenizer(
            [query] * len(senses),
            [build_doc(s) for s in senses],
            padding="max_length",
            truncation=True,
            max_length=MAX_LEN,
            return_tensors="pt",
        )
        return {
            "input_ids": encoded["input_ids"],
            "attention_mask": encoded["attention_mask"],
            "target": item["target"] - 1,
            "size": len(senses),
        }


def collate(batch):
    """把一批题的候选拼成一条长 batch，并记录每题的长度以便分组 softmax。"""
    input_ids = torch.cat([b["input_ids"] for b in batch], dim=0)
    attention_mask = torch.cat([b["attention_mask"] for b in batch], dim=0)
    targets = torch.tensor([b["target"] for b in batch], dtype=torch.long)
    sizes = [b["size"] for b in batch]
    return {"input_ids": input_ids, "attention_mask": attention_mask, "targets": targets, "sizes": sizes}


def load_split(data_dir, want_val):
    rows = []
    path = os.path.join(data_dir, "items.jsonl")
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if bool(item.get("isVal")) == want_val:
                rows.append(item)
    return rows


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    correct = 0
    total = 0
    started = time.time()
    for batch in loader:
        logits = model(
            input_ids=batch["input_ids"].to(device),
            attention_mask=batch["attention_mask"].to(device),
        ).logits.squeeze(-1)
        offset = 0
        for size, target in zip(batch["sizes"], batch["targets"].tolist()):
            chunk = logits[offset : offset + size]
            offset += size
            if int(torch.argmax(chunk).item()) == target:
                correct += 1
            total += 1
    return correct / total, correct, total, time.time() - started


def main() -> int:
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "dataset-v2"
    epochs = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    batch_items = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    lr = float(sys.argv[4]) if len(sys.argv) > 4 else 2e-5

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device={device} model={MODEL_ID}", flush=True)

    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID, num_labels=1).to(device)

    train_items = load_split(data_dir, want_val=False)
    val_items = load_split(data_dir, want_val=True)
    random.Random(0).shuffle(train_items)
    print(f"train {len(train_items)} 题 / valid {len(val_items)} 题", flush=True)

    train_loader = DataLoader(ChoiceDataset(train_items, tokenizer), batch_size=batch_items, shuffle=True, collate_fn=collate)
    val_loader = DataLoader(ChoiceDataset(val_items, tokenizer), batch_size=batch_items, shuffle=False, collate_fn=collate)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr)
    total_steps = len(train_loader) * epochs
    scheduler = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=lr, total_steps=total_steps, pct_start=0.1)

    best = 0.0
    for epoch in range(epochs):
        model.train()
        running = 0.0
        started = time.time()
        for step, batch in enumerate(train_loader):
            logits = model(
                input_ids=batch["input_ids"].to(device),
                attention_mask=batch["attention_mask"].to(device),
            ).logits.squeeze(-1)
            # 组内 softmax：直接优化「把正确义项排到第一」
            offset = 0
            losses = []
            for size, target in zip(batch["sizes"], batch["targets"].to(device).tolist()):
                chunk = logits[offset : offset + size]
                offset += size
                losses.append(F.cross_entropy(chunk.unsqueeze(0), torch.tensor([target], device=device)))
            loss = torch.stack(losses).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            running += loss.item()
            if (step + 1) % 50 == 0:
                print(f"  epoch {epoch+1} step {step+1}/{len(train_loader)} loss {running/(step+1):.4f}", flush=True)
        acc, correct, total, seconds = evaluate(model, val_loader, device)
        print(
            f"epoch {epoch+1}: train loss {running/len(train_loader):.4f} | valid acc {correct}/{total} = {acc*100:.1f}% | {seconds:.1f}s",
            flush=True,
        )
        if acc > best:
            best = acc
            model.save_pretrained("xenc-model")
            tokenizer.save_pretrained("xenc-model")
            print(f"  已保存（当前最佳 {best*100:.1f}%）", flush=True)

    print(f"\n最佳验证准确率 {best*100:.1f}%  基线：随机约 30.8%，0.5B+LoRA 约 48.8%", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
