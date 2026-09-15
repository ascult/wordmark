# 地图：语境义标注的落地 spec

## Destination

一份**可交接的 spec**：把「标注展示的是该词在这一句里的语境义」落到 wordmark 扩展——
多义项数据的形状、本地打分服务的链路与协议、权限与默认姿态、UI、评测与回退，全部定死到实现者照着能做。

**已达成** → [`spec.md`](spec.md)（`Status: ready-for-agent`）。

## Notes

- 域：Chrome MV3 扩展 + 词典义定位 + 网络取整句译文（**允许本地网络**）。
- Tracker：本地 markdown，`.scratch/context-aware-glosses/`（`gh` 未安装，未配置 GitHub Issues）。
- 每个会话动工前读 `CONTEXT.md`：`义项 / 语境义 / 义项先验 / 置信度` 已入表，`释义` 已收窄。
- 技能：决策票走 `grilling` + `domain-modeling`；事实票走 `research`；形状/观感票走 `prototype`。
- 已确认（2026-09-14 会话）：
  - 目的地是 **spec**，不是实现。
  - 运行态走**网络接口**；术语 `义项/语境义/义项先验/置信度` 已定；评测是 spec 的一章。
  - 默认姿态 = **默认开，但只允许本地网络**；无 endpoint 时静默回退现状。
  - 评测 = 人工义项级小集优先，teacher 全文翻译作大规模代理（Q4=c）。
- **待你纠正的解读**（若不对，直接说）：
  - 「整句/整段翻译」（运行态输入）与 teacher 的「全文翻译」（离线评测对照）是两件事。
  - 「继续用 ssh laptop」= 9B teacher 仍只是开发期工具，不是交付物。
  - **Q2（多义项数据的生产形状）本轮未答** → 由 `02-multisense-data-shape` 决策票解决。
- 环境事实：Node 走 **fnm**（v24.21.0，不在 login PATH，跑 `npm run …` 要手动加进 PATH）→
  票 07 已恢复，`npm run check` 全绿；多义项数据仍依赖被 gitignore 的 `.tmp-ref/TypeWords`，
  `git clone` 后不可复现。
- **工作树里已有并行实现**（2026-09-14 晚发现，作图期间落地）：`src/core/sense-selector.ts`、
  `src/core/sentence.ts`、`src/content/sentence-context.ts`、`src/background/sense.ts`、设置组 `sense.*`、
  消息 `wordmark:sense`、设置页「语境义挑选（本机模型）」一节，外加 `prototype/mt-align/xenc/serve.py`
  （FastAPI + 0.5B/LoRA 判别式打分器，`POST /select`，义项表在服务端，默认 `127.0.0.1:8317`，**默认关闭**）。
  这套代码上 `npm run check` 仍全绿：**20 文件 / 223 用例**。地图里与之冲突的结论都已标注作废。

## Decisions so far

<!-- 每关闭一张票，追加一行：- [票名](issues/NN-slug.md)：一句话结论 -->

- [多义项数据的生产形状](issues/02-multisense-data-shape.md)：产物入库（`data/senses/cet4.json`，独立于
  `data/parts|imported` 以免被当词条校验）+ 并进 `dict.zh.json` 的可选 `senses` 字段，
  `senses[0] === gloss`、≤6 条、每条 ≤14 字；本次只覆盖 CET-4 2,602 词，437 条缺口另议。
  **补注**：现行实现把义项表放在服务端（扩展不打包），所以「并进 `dict.zh.json`」降级为
  「只有推理搬进页内才需要」的条件决定；但 Q1（产物入库、可复现）不受影响，反而更紧迫。
- [评测设计](issues/06-eval-design.md)：人工义项级小集（`data/eval/sense-gold.jsonl`，150–200 条，盲标）
  管绝对质量，`dataset-v2` 的 teacher 标签只作相对排序（不是准确率）；新台子 `scripts/sense-eval.mjs`
  离线可复现，跑五个基线（含现状「永远首义项」）；上线门槛是人工集 top1 提升的 95% CI 不含 0。
- [恢复可运行环境](issues/07-node-toolchain.md)：Node 走 fnm（v24.21.0，不在 login PATH）；`npm run check`
  已全绿（164 用例）。顺带修掉 `src/content/index.ts:63`：在线查词代理错解 `sendRequest` 的 `{ok,data}` 信封，
  导致**在线查词一直恒返回 null**。基线提交未做——首次提交前必须先扩 `.gitignore`，否则会把 945MB 的
  `xenc/scorer.safetensors` 等二进制灌进仓库。
- [运行态翻译接口的事实](issues/01-translation-endpoint-facts.md)：MyMemory 能翻整句（≤500 字符）但无子句对齐、
  匿名仅 5,000 字符/天、数据长期留存并共享第三方；现有 `{word}` 契约载不了句子；MV3 扩展有主机权限即可访问
  本地/局域网（Chrome 明确 LNA 不适用于扩展）；llama.cpp 支持一次多句，MLX 只能并发。
- ~~[运行态链路与 provider 选型](issues/03-runtime-mechanism-and-provider.md)：方法优先 + 端点整句翻译~~
  ——**已作废**：作图期间工作树里落地了实现完毕的**本地判别式打分器**通路（`xenc/serve.py`，
  义项表在服务端），既不取译文、也不做「方法定位」。残留决定拆到 10、04、09。
- [默认姿态 · 端点白名单 · 文案](issues/04-privacy-permissions-ux.md)：语境义**保持默认关闭**
  （推翻先前「默认开」）；端点只允许本机/局域网（http/https 同等对待），且校验要落进
  `sanitizeEndpoint` 而不是只留在设置页 UI——现在导入一份 JSON 就能把整句发到公网 https 地址；
  已写 ADR `docs/adr/0001-local-only-sentence-context.md`；README 的「默认纯离线」需收窄。
- [打分器如何成为可交付件](issues/10-scorer-delivery.md)：定义为**自托管的伴随服务**，搬出 `prototype/`
  到 `tools/sense-server/`（带 requirements / 启动脚本 / README）；**只支持 Apple Silicon**；
  基座模型不入仓库（给 HF ID），适配器入仓库但**版本化且只留一个**，义项表入 `data/senses/`；
  协议（`/select`、`/health`）固化并加 `protocolVersion`；质量门槛不认 71.8%（同分布留出集），
  用 06 的人工集；评测与生产**共用同一套切句**是硬约束。
- [置信度与 UI](issues/05-confidence-and-ui.md)：**正文里不做视觉区分**（语境义与词典义外观一致）；
  「有没有生效」改由弹窗聚合显示（`PageStats` 加 `contextual` / `senseReachable`）；不做悬停译文
  （现行实现不取译文）；不做未校准的分数阈值降级；「已认识」保持词级语义；按处替换（`updateGlossText`）
  是硬约束。
- [延迟与批处理](issues/09-latency-and-batching.md)：发现并要修一个缺陷——`SenseSelector` 把「请求失败」
  与「没得选」缓存成同一件事，一次超时会永久禁用整批；算术上 `maxPerPage 300` × 61ms/题 ≈ 18 秒
  远超 `timeoutMs 8000`，长页面默认必然超时。决定：失败不落缓存、按 32 题分片顺序发（服务端有全局锁，
  并发无意义）、单批超时改 3000ms、候选按阅读顺序先到先得；不为吞吐去重训定宽填充（移出范围）。

## Not yet specified

- 用 03 选定的链路，给那 437 条没有多义项的词（人工整理与 basic 档，恰是最该判义项的难词）补义项。

## Out of scope

<!-- 本次目的地之外，不随 frontier 前进而 graduate -->

- **义项先验的打包与扩大蒸馏**（[义项先验](issues/08-sense-prior.md)）：先验只影响离线默认顺序、
  不参与语境义判定，当前又只覆盖 488 / 3,039 词（22.3% 的词会改变首项）。本次回复语义定为
  **回退到现状 `senses[0]`**；若将来打包，先验只能重排 `senses[1..]`、永不覆盖 `senses[0] === gloss`，
  且必须标为最低档（先验 ≠ 语境义）。
- **浏览器内本地小模型**（ONNX/WebGPU，含 LoRA/xenc 那条线）：03 已把运行态定为本地网络端点，
  这条替代实现被本次机制决策排除。
- **为重训「定宽填充」而改批次策略**：分片已让超时可控，重训只提升吞吐；单页几百处的场景下不值得，
  移出本次范围（`prototype/mt-align/README.md` 的「还没测的」里也记着这条）。
- **把打分器搬进浏览器**（ONNX/WebGPU 页内推理）：`SensePicker` 保留了扩展点，但本次不作为交付路径；
  若将来要走，02 里「义项表打包」的条件决定会复活。
- **非 Apple Silicon 平台**（Windows / Linux / Intel Mac）：本次只支持 mlx 能跑的环境，其余不承诺；
  跨平台要另做 llama.cpp / ONNX 版本。
- **把整句译文发往公网服务**（MyMemory 等）：与本次「默认开但只允许本地网络」的姿态直接冲突，
  且匿名配额仅 5,000 字符/天、提交内容长期留存并共享给第三方。现有针对**单词**的 MyMemory 兜底保持不变。
- Firefox / Safari 适配（README roadmap 项，与本目的地无关）。
- 生词本导出到 Anki / CSV（同上）。
