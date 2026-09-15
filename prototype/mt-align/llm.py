#!/usr/bin/env python3
"""
原型：本地小模型做「译文 → 原词」对齐的批量执行器。

【原型代码，不是生产实现】

约定：从 stdin 读 JSONL，每条 {"id": ..., "system": ..., "user": ...}，
      往 stdout 写 JSONL，每条 {"id": ..., "raw": "<模型输出>"}。
一次加载模型、循环处理，避免每个请求都重新加载。

用 mlx-lm（Apple MLX）在 M 系列芯片上跑 4bit 量化的小指令模型。
"""

import json
import sys

from mlx_lm import generate, load


def main() -> int:
    model_id = sys.argv[1] if len(sys.argv) > 1 else "mlx-community/Qwen2.5-1.5B-Instruct-4bit"
    max_tokens = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    model, tokenizer = load(model_id)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        messages = [
            {"role": "system", "content": request["system"]},
            {"role": "user", "content": request["user"]},
        ]
        prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
        text = generate(model, tokenizer, prompt=prompt, max_tokens=max_tokens, verbose=False)
        sys.stdout.write(json.dumps({"id": request["id"], "raw": text}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
