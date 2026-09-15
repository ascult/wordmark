#!/usr/bin/env python3
"""
把 save_weights() 存下的完整权重收缩成**真适配器**（只留 LoRA + 打分头）。

【原型代码，不是生产实现】

背景：`scorer.save_weights()` 会把整个 0.5B 编码器也写进去 —— 实测 994MB。
可训练参数只有 1.47M（0.30%），适配器本该是几 MB。
本脚本按参数名过滤（mlx-lm 的 LoRA 参数叫 lora_a/lora_b，打分头叫 head.*），
不需要加载模型，纯文件 I/O。

用法：python shrink_adapter.py [输入] [输出]
"""

import sys

import mlx.core as mx
from mlx.utils import tree_flatten


def main() -> int:
    source = sys.argv[1] if len(sys.argv) > 1 else "prototype/mt-align/xenc/scorer.safetensors"
    target = sys.argv[2] if len(sys.argv) > 2 else "prototype/mt-align/xenc/adapter.safetensors"

    full = mx.load(source)
    keep = {
        key: value
        for key, value in full.items()
        if "lora_a" in key or "lora_b" in key or key.startswith("head.")
    }
    if not keep:
        raise SystemExit("没有匹配到 LoRA/head 参数，检查参数名约定")

    total = sum(value.size for value in keep.values())
    mx.save_safetensors(target, keep)
    print(f"{len(full)} 个参数 → 保留 {len(keep)} 个（{total/1e6:.2f}M 参数）")
    print(f"输出：{target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
