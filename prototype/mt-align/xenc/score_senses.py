#!/usr/bin/env python3
"""
判别式打分器的**运行时形态**：句子 + 目标词 + 候选义项 → 选中哪个义项。

【原型代码，不是生产实现】

这就是产品里要的那一步：给定真实句子与词典义项，输出语境义（义项序号）。
推理是「每个义项一次前向 + argmax」，**结构上不可能输出非法序号**，也不需要自回归解码。

用法：
  python score_senses.py "句子" 单词 "义项1|义项2|义项3"
  python score_senses.py                    # 不带参数则跑内置的几个真实样例
"""

import sys
import time

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_unflatten
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers

MODEL_ID = "mlx-community/Qwen2.5-0.5B-Instruct-bf16"
ADAPTER = "prototype/mt-align/xenc/adapter.safetensors"
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


def load_scorer():
    model, tokenizer = load(MODEL_ID)
    model.freeze()
    linear_to_lora_layers(model.model, LORA_LAYERS, {"rank": 8, "scale": 20.0, "dropout": 0.0})
    probe = tokenizer.encode(build_text("x", "x", "x"))[:8]
    dim = model.model(mx.array([probe])).shape[-1]
    scorer = Scorer(model.model, dim)
    weights = mx.load(ADAPTER)
    # 适配器只含可训练参数（LoRA + 头），所以 strict=False 局部更新
    scorer.update(tree_unflatten(list(weights.items())), strict=False)
    mx.eval(scorer.parameters())
    return scorer, tokenizer


def score(scorer, tokenizer, sentence, word, senses):
    ids = [tokenizer.encode(build_text(sentence, word, s))[-MAX_TOKENS:] for s in senses]
    width = max(len(x) for x in ids)
    padded = [x + [0] * (width - len(x)) for x in ids]
    logits = scorer(padded)
    mx.eval(logits)
    values = [float(v) for v in logits]
    best = int(mx.argmax(logits).item())
    return best, values


SAMPLES = [
    (
        "Ambitious people are if anything already too conservative about it.",
        "conservative",
        ["保守的", "保守派的/保守主义的", "守旧的/传统的", "不愿冒险的/谨慎的"],
    ),
    (
        "There's a kind of excited curiosity that's both the engine and the rudder of great work.",
        "engine",
        ["发动机/引擎", "机车/火车头", "专用装备/器械", "工具/手段", "驱动力/推动力"],
    ),
    (
        "It is not just an abstract idea.",
        "abstract",
        ["抽象的/纯概念的", "理论上的/不切实际的", "摘要/梗概"],
    ),
]


def main() -> int:
    scorer, tokenizer = load_scorer()
    cases = []
    if len(sys.argv) >= 4:
        cases.append((sys.argv[1], sys.argv[2], sys.argv[3].split("|")))
    else:
        cases = SAMPLES

    for sentence, word, senses in cases:
        started = time.time()
        best, values = score(scorer, tokenizer, sentence, word, senses)
        elapsed = (time.time() - started) * 1000
        print(f"\n句子：{sentence}")
        print(f"单词：{word}")
        for index, (sense, value) in enumerate(zip(senses, values)):
            mark = "→" if index == best else " "
            print(f"  {mark} {index+1}) {sense:<24} 分数 {value:+.3f}")
        print(f"  选中：{senses[best]}   （{len(senses)} 个义项共 {elapsed:.0f}ms，约 {elapsed/len(senses):.0f}ms/义项）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
