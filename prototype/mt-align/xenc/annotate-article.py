#!/usr/bin/env python3
"""
真实文章端到端：对整篇文章的每个（句子 × 多义词）打分选义，输出带注的正文。

【原型代码，不是生产实现】

与 `score_senses.py` 的区别：那个是**个案抽查**（手写 3 个样例），
这个是**整篇跑**，用来回答两个问题：
  1. 质量：真实文章上选出来的义项是不是语境义（同分布留出集之外的检验）；
  2. 成本：一整篇到底要多少秒、能不能接受（README 里 19 秒/篇的估计值要被实测替换）。

输入由 `pick-candidates.mjs` 生成（切句与生产一致），本脚本只负责打分。

用法：
  python prototype/mt-align/xenc/annotate-article.py [annotate-input.json] [--adapter=PATH] [--out=MD]
"""

import json
import sys
import time

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_unflatten
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers

MODEL_ID = "mlx-community/Qwen2.5-0.5B-Instruct-bf16"
DEFAULT_INPUT = "prototype/mt-align/xenc/annotate-input.json"
DEFAULT_ADAPTER = "prototype/mt-align/xenc/adapter.safetensors"
LORA_LAYERS = 8
MAX_TOKENS = 160


def build_text(sentence, word, sense):
    return f"单词：{word}　句子：{sentence}\n义项：{sense}"


class Scorer(nn.Module):
    def __init__(self, encoder, dim):
        super().__init__()
        self.encoder = encoder
        self.head = nn.Linear(dim, 1)

    def __call__(self, batch_ids):
        hidden = self.encoder(mx.array(batch_ids))
        return self.head(hidden[:, -1, :]).squeeze(-1)


def load_scorer(adapter):
    model, tokenizer = load(MODEL_ID)
    model.freeze()
    linear_to_lora_layers(model.model, LORA_LAYERS, {"rank": 8, "scale": 20.0, "dropout": 0.0})
    probe = tokenizer.encode(build_text("x", "x", "x"))[:8]
    dim = model.model(mx.array([probe])).shape[-1]
    scorer = Scorer(model.model, dim)
    scorer.update(tree_unflatten(list(mx.load(adapter).items())), strict=False)
    mx.eval(scorer.parameters())
    return scorer, tokenizer


def score(scorer, tokenizer, sentence, word, senses):
    """一题一次前向（K 个义项共享一次上下文编码），返回 (选中下标, 各义项分数)。"""
    ids = [tokenizer.encode(build_text(sentence, word, s))[-MAX_TOKENS:] for s in senses]
    width = max(len(x) for x in ids)
    logits = scorer([x + [0] * (width - len(x)) for x in ids])
    mx.eval(logits)
    values = [float(v) for v in logits]
    return int(mx.argmax(logits).item()), values


def main() -> int:
    positional = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
    src = positional[0] if positional else DEFAULT_INPUT
    adapter = flags.get("--adapter", DEFAULT_ADAPTER)
    out_path = flags.get("--out", "")

    with open(src, encoding="utf-8") as handle:
        payload = json.load(handle)
    items = payload["items"]
    print(f"文章：{payload['article']}")
    print(f"{payload['sentences']} 句 → {len(items)} 个决策点；适配器 {adapter}")

    scorer, tokenizer = load_scorer(adapter)

    # 预热：第一次前向含模型图编译，单独计掉，否则会污染单题延迟
    warm = time.time()
    score(scorer, tokenizer, items[0]["sentence"], items[0]["word"], items[0]["senses"])
    print(f"预热 {1000 * (time.time() - warm):.0f}ms")

    results = []
    per_item = []
    started = time.time()
    for item in items:
        t0 = time.time()
        best, values = score(scorer, tokenizer, item["sentence"], item["word"], item["senses"])
        per_item.append(1000 * (time.time() - t0))
        results.append({**item, "best": best, "values": values})
    total = time.time() - started

    senses_total = sum(len(r["senses"]) for r in results)
    print(f"\n整篇 {total:.1f} 秒（{len(results)} 个决策点 / {senses_total} 个义项）")
    print(f"  每题均 {1000 * total / max(1, len(results)):.0f}ms；每个义项 {1000 * total / max(1, senses_total):.1f}ms")
    ordered = sorted(per_item)
    print(f"  单题延迟 中位 {ordered[len(ordered)//2]:.0f}ms / 95 分位 {ordered[int(len(ordered)*0.95)]:.0f}ms / 最大 {ordered[-1]:.0f}ms")

    # 按句聚合，输出带注的正文
    lines = []
    current = None
    for r in results:
        if r["sentence"] != current:
            current = r["sentence"]
            lines.append("")
            lines.append(f"> {current}")
        lines.append(
            f"  - {r['word']} → {r['senses'][r['best']]}"
            f"   （{len(r['senses'])} 个义项，选中第 {r['best'] + 1} 个）"
        )

    body = "\n".join(lines)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(f"# 真实文章端到端注义（{payload['article']}）\n")
            handle.write(f"\n{payload['sentences']} 句 / {len(results)} 个决策点 / {total:.1f} 秒\n")
            handle.write(body + "\n")
        print(f"  已写 {out_path}")

    # 「总选第 1 个义项」的比例：用来暴露位置偏差（词典序通常是常用义先行，
    # 所以这个数高不一定是错，但结合个案能看出模型是否在真读句子）
    first = sum(1 for r in results if r["best"] == 0)
    print(f"\n选中「第 1 个义项」的比例 {first}/{len(results)} = {100 * first / max(1, len(results)):.1f}%")
    print("（词典序一般把常用义放前面；这个数说明模型在多大程度上跟随/偏离字典序）")

    print("\n--- 输出预览（前 40 行）---")
    print("\n".join(body.splitlines()[:40]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
