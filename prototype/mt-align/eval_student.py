#!/usr/bin/env python3
"""
原型：评测学生在「义项选择题」上的准确率（基础模型 vs 微调后）。

【原型代码，不是生产实现】

样本来自 dataset/items.jsonl 里的验证集，义项顺序已按样本 id 确定性打乱，
目标是一个序号。随机基线约 30%（见 make-dataset 的输出）。

用法：
  python eval_student.py <model_id> <adapter_path|-> [items_file] [limit]
"""

import json
import re
import sys
import time

from mlx_lm import generate, load

SYSTEM = "你是英语词典编辑助手。只输出要求的答案，不解释。"


def main() -> int:
    model_id = sys.argv[1]
    adapter = sys.argv[2]
    items_file = sys.argv[3] if len(sys.argv) > 3 else "prototype/mt-align/dataset/items.jsonl"
    limit = int(sys.argv[4]) if len(sys.argv) > 4 else 200

    rows = []
    with open(items_file, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if item.get("isVal"):
                rows.append(item)
    rows = rows[:limit]

    model, tokenizer = load(model_id, adapter_path=None if adapter == "-" else adapter)

    correct = 0
    invalid = 0
    latencies = []
    samples = []
    for item in rows:
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": item["user"]},
        ]
        prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        started = time.time()
        raw = generate(model, tokenizer, prompt=prompt, max_tokens=4, verbose=False)
        latencies.append((time.time() - started) * 1000)
        match = re.search(r"\d+", str(raw))
        guess = int(match.group()) if match else 0
        if 1 <= guess <= len(item["shuffledSenses"]):
            if guess == item["target"]:
                correct += 1
        else:
            invalid += 1
        if len(samples) < 8:
            samples.append((item, guess, str(raw).strip()[:12]))

    total = len(rows)
    print(f"模型 {model_id}  适配器 {adapter}")
    print(f"验证样本 {total} 条（义项已打乱，随机基线约 30%）")
    print(f"  准确率 {correct}/{total} = {correct / total * 100:.1f}%   无效输出 {invalid}  平均 {sum(latencies)/total:.0f}ms/条")
    print("  样例：")
    for item, guess, raw in samples:
        mark = "✓" if guess == item["target"] else "✗"
        print(
            f"    {mark} {item['word']:<14} 目标={item['target']} 预测={guess} 原文={raw!r}  义项={item['shuffledSenses'][:item['target']-1] + ['→' + item['shuffledSenses'][item['target']-1]]}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
