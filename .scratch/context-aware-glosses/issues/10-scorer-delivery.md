Type: grilling
Status: resolved
Blocked by: 无

## Question

`prototype/mt-align/xenc/serve.py` 自称「**原型代码，不是生产实现**」——它要怎么变成可交付件？

它现在是让语境义真正生效的唯一一环：FastAPI + uvicorn + mlx_lm，加载 0.5B 基座 + LoRA
（`xenc/adapter.safetensors`，几 MB）与义项表（`prototype/mt-align/senses.json`，229K），
暴露 `POST /select`、`GET /health`，默认 `127.0.0.1:8317`，逐题前向（13ms/义项）。

要定：

- **交付形态**：留在 `prototype/`（用户自己起进程，扩展经 `sense-endpoint` 连过去），
  还是提升为正式的、可分发的件（一键起服务 / 安装脚本 / 打包）？
- **依赖与平台**：Python + mlx 目前只在 Apple Silicon 上跑得动；Windows/Linux 怎么办（llama.cpp 版？不做？）。
- **模型与适配器分发**：基座 + LoRA + 义项表从哪来、要不要入仓库、`.gitignore` 怎么处理
  （参见票 07：`xenc/scorer.safetensors` 有 945MB）。
- **失败语义**：服务没起 / 版本不匹配 / 词不在表里——实现已是静默回退，确认这就是终态。
- **与 `SensePicker` 扩展点的关系**：接口注释说「将来换成 ONNX / WebGPU 的页内推理不必改 `pipeline.ts`」。
  那条路留不留作正式备选？若留，02 里「义项表打包」的决定就要复活。

闭票时给出：交付形态 + 平台覆盖 + 分发方式 + 与页内推理路线的关系。

## Answer

用户委托我决策。依据 `prototype/mt-align/README.md:459-507`（服务契约与已验证记录）与实测文件。

**1) 交付形态 = 自托管的伴随服务（companion service），但必须搬出 `prototype/`。**
现状自相矛盾：`serve.py` 头部写着「原型代码，不是生产实现」，而扩展的选项页已经把它当正式依赖指路，
扩展侧也真的依赖它。spec 里把它定义为**随扩展自托管的一份伴随服务**：提升到 `tools/sense-server/`，
自带 `requirements.txt`、启动脚本与 README（依赖、模型下载、自检、`/health` 探测）。
扩展**只依赖协议**，不依赖它的存放位置。

**2) 平台 = 本次只支持 Apple Silicon。** mlx 只在 Apple Silicon 上跑得动；Windows / Linux / Intel Mac
**明确不承诺**，写进「已知限制」。跨平台要另做 llama.cpp / ONNX 版本 → 移出范围。

**3) 分发**：
- **基座模型不入仓库**：文档给 HF ID（`mlx-community/Qwen2.5-0.5B-Instruct-bf16`）与下载命令。
- **适配器入仓库**：约 5.9MB 可接受。但必须**版本化并只留一个**——现在 `xenc/` 下同时躺着
  `adapter.safetensors` 与 `adapter-v2-long.safetensors`，旧目录还有 `adapters/`、`adapters-v2/`，
  并存会让「71.8%」对应不上任何确定的产物。命名 `sense-scorer-0.5b-v1.safetensors`，其余删或归档。
- **义项表入 `data/senses/`**（承接 02 的 Q1）：它已经是这条通路的必需输入，却仍由被 gitignore 的
  `.tmp-ref` 生成，clone 后重建不出来。
- **`.gitignore` 必须补**：`prototype/mt-align/xenc/scorer.safetensors`（945MB）、`*.npz`、`__pycache__/`。

**4) 协议固化为 spec 的一部分**：`POST /select`（入参 `{items:[{id, sentence, word, senses?}]}`，
出参 `{results:[{id, index, selected, senses, scores, ms}]}`）与 `GET /health`。
两点写进契约：`index: -1` + `reason`（词不在表里 / 只有 1 个义项）**不是错误**，调用方保持原释义不动；
服务端 `maxItems`（2048）超出即拒。新增 **`protocolVersion`** 到 `/health`，扩展核对不上就静默回退——
否则扩展与服务的版本会悄悄错配。

**5) 质量门槛不认 71.8%**：它是**同分布留出集**上的数字，只能当相对指标；上线门槛用 06 的人工集 top1
（95% CI 不含 0）。另注意真实文章的义项数分布不同（实测平均 **4.67**，留出集 3.59），
所以 06 的抽样必须按真实分布分层。

**6) 保留一条已有决策**：评测与生产**共用同一套切句**——切句放 Node 侧（复用 `mt.mjs` 的
`splitSentences`/`candidateWords`），中间用 JSON 交给 MLX，不许在 Python 里重写一遍。
spec 要把它写成硬约束，否则「测出来的数不是线上的数」。

**7) 与页内推理的关系**：`SensePicker` 的 ONNX/WebGPU 扩展点**保留但不走**，本次不作为交付路径；
若将来要走，02 里「义项表打包」的条件决定会复活。→ 记入 Out of scope。
