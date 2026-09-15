#!/usr/bin/env python3
"""
语境义打分器的**本地推理服务**（把 `score_senses.py` 包成 HTTP）。

【原型代码，不是生产实现】

产品里 content script 拿到一个句子里的生词后，把它与词典的 K 个义项发到这里，
拿回「哪个义项最合语境」，再异步替换掉原来那条字典义。

## 一个必须守住的约束：**逐题前向，不要跨题乱批**

训练时（`train_scorer_lora.py` 的 `encode_batch`）每个题目的 K 个义项**右填充**到
「本题最长的那条」的长度，然后取**最后一个位置**的隐状态（`hidden[:, -1, :]`）。
短的那几条，读出的其实是填充位——这是一个被训练固定下来的池化约定。

推论：**读出位置取决于填充宽度**。如果把不同题目的义项混进同一个矩形批次，
所有序列会被填充到「整批最长」，短题目的读出位置就平移了，
与训练分布不一致，准确率会掉。所以这里**一题一次前向**（K 个义项一次算完，
上下文只编码一遍），这也是「13ms/义项」这个数字的来源。

想要真正的大批次吞吐，得**重训**成定宽填充（或左填充取末位真实 token），
那样批次才可任意合并——见 README「还没测的」。

## 用法

  # 起服务（默认 127.0.0.1:8317）
  python prototype/mt-align/xenc/serve.py [--adapter=PATH] [--senses=PATH] [--port=8317]

  # 自检：不起 HTTP，直接跑内置样例
  python prototype/mt-align/xenc/serve.py --self-test

请求：
  POST /select
  {"items": [{"id": "s1", "sentence": "...", "word": "engine"}]}
  # senses 可省略：省略时按 word 查服务端的义项表（推荐，扩展就不必打包 229K 的义项数据）
  # 也可以显式带上 senses 覆盖服务端表，便于调试。
响应：
  {"results": [{"id": "s1", "index": 4, "selected": "驱动力/推动力", "senses": [...], "scores": [...], "ms": 41.2}]}
  没有可选项时 `index` 为 -1、`reason` 说明原因（词不在表里 / 只有 1 个义项），调用方应保持原释义不动。
"""

import json
import sys
import threading
import time

import mlx.core as mx
import mlx.nn as nn
from mlx.utils import tree_unflatten

MODEL_ID = "mlx-community/Qwen2.5-0.5B-Instruct-bf16"
DEFAULT_ADAPTER = "prototype/mt-align/xenc/adapter.safetensors"
DEFAULT_SENSES = "data/senses/cet4.json"
LORA_LAYERS = 8
MAX_TOKENS = 160
# 单次请求最多处理多少个决策点：防止一个超大请求把内存打满
MAX_ITEMS = 2048


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


class SenseScorer:
    """加载一次、常驻；`select()` 是唯一的对外能力。"""

    def __init__(self, adapter: str = DEFAULT_ADAPTER, senses_path: str = DEFAULT_SENSES):
        from mlx_lm import load
        from mlx_lm.tuner.utils import linear_to_lora_layers

        self.adapter = adapter
        self.senses_path = senses_path
        with open(senses_path, encoding="utf-8") as handle:
            table = json.load(handle)
        # 只留真正有多义项的词：单义项的词调用方不该发过来，发来了也没得选
        self.senses_table = {word: list(items) for word, items in table.items() if len(items) >= 2}

        model, tokenizer = load(MODEL_ID)
        model.freeze()
        linear_to_lora_layers(model.model, LORA_LAYERS, {"rank": 8, "scale": 20.0, "dropout": 0.0})
        probe = tokenizer.encode(build_text("x", "x", "x"))[:8]
        dim = model.model(mx.array([probe])).shape[-1]
        scorer = Scorer(model.model, dim)
        scorer.update(tree_unflatten(list(mx.load(adapter).items())), strict=False)
        mx.eval(scorer.parameters())
        self.scorer = scorer
        self.tokenizer = tokenizer
        # MLX 的图执行不是线程安全的：FastAPI 的同步端点跑在线程池里，必须串行化推理
        self.lock = threading.Lock()
        # 预热：第一次前向含图编译，别让首个真实请求等它
        self.select("It is not just an abstract idea.", "abstract", ["抽象的/纯概念的", "摘要/梗概"])

    def candidates(self, word: str, given: list[str] | None) -> tuple[list[str] | None, str | None]:
        """决定这一题有没有可选的义项；返回 (义项列表, 跳过原因)。"""
        senses = given if given else self.senses_table.get(word.lower())
        if not senses:
            return None, "unlisted"
        if len(senses) < 2:
            return None, "single-sense"
        return senses, None

    def select(self, sentence: str, word: str, senses: list[str]) -> tuple[int, list[float]]:
        if not senses:
            raise ValueError("senses 不能为空")
        with self.lock:
            ids = [
                self.tokenizer.encode(build_text(sentence, word, sense))[-MAX_TOKENS:]
                for sense in senses
            ]
            width = max(len(x) for x in ids)  # 本题的填充宽度——必须与训练一致
            logits = self.scorer([x + [0] * (width - len(x)) for x in ids])
            mx.eval(logits)
            values = [float(v) for v in logits]
            return int(mx.argmax(logits).item()), values


def build_app(state: SenseScorer):
    from fastapi import FastAPI
    from pydantic import BaseModel

    app = FastAPI(title="wordmark sense scorer", version="0.1.0")

    class Item(BaseModel):
        id: str | None = None
        sentence: str
        word: str
        senses: list[str] | None = None

    class SelectRequest(BaseModel):
        items: list[Item]

    @app.get("/health")
    def health():
        return {
            "ok": True,
            "model": MODEL_ID,
            "adapter": state.adapter,
            "senses": state.senses_path,
            "multiSenseWords": len(state.senses_table),
            "maxItems": MAX_ITEMS,
        }

    @app.post("/select")
    def select(request: SelectRequest):
        if len(request.items) > MAX_ITEMS:
            return {"error": f"items 超过上限 {MAX_ITEMS}"}
        results = []
        for item in request.items:
            senses, reason = state.candidates(item.word, item.senses)
            if senses is None:
                # 没有可选的义项：明确告诉调用方保持原释义，不要当成错误
                results.append({"id": item.id, "index": -1, "reason": reason})
                continue
            started = time.time()
            index, scores = state.select(item.sentence, item.word, senses)
            results.append(
                {
                    "id": item.id,
                    "index": index,
                    "selected": senses[index],
                    "senses": senses,
                    "scores": scores,
                    "ms": round(1000 * (time.time() - started), 1),
                }
            )
        return {"results": results}

    return app


SELF_TEST = [
    (
        "There's a kind of excited curiosity that's both the engine and the rudder of great work.",
        "engine",
        ["发动机/引擎", "机车/火车头", "专用装备/器械", "工具/手段", "驱动力/推动力"],
        4,  # 期望选中「驱动力/推动力」（隐喻义）
    ),
    (
        "It is not just an abstract idea.",
        "abstract",
        ["抽象的/纯概念的", "理论上的/不切实际的", "摘要/梗概"],
        0,
    ),
]


def self_test(adapter: str, senses_path: str) -> int:
    scorer = SenseScorer(adapter, senses_path)
    failed = 0
    for sentence, word, senses, expected in SELF_TEST:
        started = time.time()
        index, scores = scorer.select(sentence, word, senses)
        elapsed = 1000 * (time.time() - started)
        ok = index == expected
        failed += 0 if ok else 1
        print(f"[{'OK ' if ok else 'FAIL'}] {word} → {senses[index]}（{elapsed:.0f}ms）")
        print(f"       分数 {[round(s, 3) for s in scores]}")

    # 义项表路径：不传 senses，由服务端查表
    for word, expect_reason in (("engine", None), ("zzzznotaword", "unlisted")):
        senses, reason = scorer.candidates(word, None)
        ok = reason == expect_reason
        failed += 0 if ok else 1
        shown = f"{len(senses)} 个义项" if senses else f"跳过（{reason}）"
        print(f"[{'OK ' if ok else 'FAIL'}] 查表 {word}：{shown}")

    print(f"\n自检 {'通过' if failed == 0 else f'失败 {failed} 项'}")
    return 1 if failed else 0


def main() -> int:
    flags = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
    adapter = flags.get("--adapter", DEFAULT_ADAPTER)
    senses_path = flags.get("--senses", DEFAULT_SENSES)
    if "--self-test" in sys.argv:
        return self_test(adapter, senses_path)

    import uvicorn

    host = flags.get("--host", "127.0.0.1")
    port = int(flags.get("--port", "8317"))
    print(f"加载打分器（适配器 {adapter}）…", flush=True)
    state = SenseScorer(adapter, senses_path)
    print(f"义项表 {senses_path}：{len(state.senses_table)} 个多义词", flush=True)
    print(f"就绪：http://{host}:{port}   POST /select   GET /health", flush=True)
    uvicorn.run(build_app(state), host=host, port=port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
