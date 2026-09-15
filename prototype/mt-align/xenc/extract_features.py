#!/usr/bin/env python3
"""
用本地的 0.5B 当**冻结编码器**抽特征，供判别式打分头训练。

【原型代码，不是生产实现】

为什么走 mlx 而不是 torch：这台机器和 laptop 访问 PyPI 的 wheel CDN 都慢到不可用
（30MB 下不完），但 HuggingFace 有 1.2MB/s，而 0.5B 已经在本地的 MLX 缓存里。
MLX 自带 autograd，够用来训一个线性头。

抽取方式：对每个 (句子, 义项) 对，把文本喂给模型，取**最后一个 token 的隐状态**
（这是把 decoder-only 模型当编码器用的标准做法）。编码器全程冻结，
只训练评分头 w·h + b，同一题的 K 个义项一起做 softmax。

用法：python extract_features.py [items.jsonl] [out.npz] [limit]
"""

import json
import sys
import time

import mlx.core as mx
import numpy as np
from mlx_lm import load

MODEL_ID = "mlx-community/Qwen2.5-0.5B-Instruct-4bit"
MAX_TOKENS = 160


def build_text(item, sense):
    """查询里必须写明是哪个词，否则同句多词时题目本身有歧义。"""
    return f"单词：{item['word']}　句子：{item['sentence']}\n义项：{sense}"


def main() -> int:
    items_file = sys.argv[1] if len(sys.argv) > 1 else "prototype/mt-align/dataset-v2/items.jsonl"
    out_file = sys.argv[2] if len(sys.argv) > 2 else "prototype/mt-align/xenc/features.npz"
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 0

    items = []
    with open(items_file, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    if limit:
        items = items[:limit]

    print(f"加载 {MODEL_ID}（冻结编码器）", flush=True)
    model, tokenizer = load(MODEL_ID)

    # 取隐状态：mlx-lm 的顶层模型是 lm_head(inner(...))，内层返回隐状态
    inner = getattr(model, "model", None)
    if inner is None:
        raise SystemExit("找不到内层模型，无法取隐状态")
    print(f"内层模型: {type(inner).__name__}", flush=True)

    features = []
    sizes = []
    targets = []
    is_val = []
    started = time.time()
    for index, item in enumerate(items):
        senses = item["shuffledSenses"]
        rows = []
        for sense in senses:
            ids = tokenizer.encode(build_text(item, sense))[-MAX_TOKENS:]
            hidden = inner(mx.array([ids]))
            mx.eval(hidden)
            rows.append(np.array(hidden[0, -1, :].astype(mx.float16)))
        features.append(np.stack(rows))
        sizes.append(len(senses))
        targets.append(item["target"] - 1)
        is_val.append(bool(item.get("isVal")))
        if (index + 1) % 200 == 0:
            elapsed = time.time() - started
            print(f"  {index+1}/{len(items)}  {elapsed:.0f}s  ({elapsed/(index+1)*1000:.0f}ms/题)", flush=True)

    np.savez_compressed(
        out_file,
        features=np.concatenate(features, axis=0),
        sizes=np.array(sizes),
        targets=np.array(targets),
        is_val=np.array(is_val),
    )
    total = sum(sizes)
    print(f"完成：{len(items)} 题 / {total} 个 (句子,义项) 对 → {out_file}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
