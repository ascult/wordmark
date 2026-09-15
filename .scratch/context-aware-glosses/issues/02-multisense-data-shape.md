Type: grilling
Status: resolved
Blocked by: 无

## Question

多义项词典以什么形状进生产，并保证 `git clone` 之后可复现？

现在的状况：`prototype/mt-align/senses.json` 是 2,602 词 / 2,413 个多义项（每词 ≤6 个、每个 ≤10 字），
由 `build-senses.mjs` 从 `.tmp-ref/TypeWords/.../CET4_T.json` 生成——而 `.tmp-ref/` 被 gitignore。
生产词表 `dict.zh.json` 每词只有一条 ≤14 字 gloss。

要定：

- 源数据入库，还是只把**生成产物**作为源数据入库（不再依赖 `.tmp-ref`）？
- `npm run dict` 的合并与校验怎么扩展（现有校验：小写 ASCII、唯一、释义 ≤14 字含中文、难度合法、
  `alt` 不冲突；多义项的条数/单条长度上限要不要一起校验）？
- `senses.json` 的已知噪声（`whatever → 名叫某某的东西`、`cancel → 邮票注销章/戳记`）怎么处理；
  是否按原型建议，把人工整理的那条释义**固定为一个候选**，保证「好的那一项」永远在选项里。
- 体积与打包影响（现在 dist 里 content.js ~192KB、词典 ~197KB）。

闭票时给出数据形状（JSON schema）+ 构建流程 + 校验规则。

## Answer

用户把决策委托给我，四问按下列结论关闭。

**Q1 数据来源 = 产物入库。** 新增 `data/senses/cet4.json`，形状沿用原型：`{ "<word>": ["义项", …] }`，
每词 ≤6 条、每条 ≤14 字。它是**源数据，不是 dict 分片**——绝不能放 `data/parts/` 或 `data/imported/`，
因为 `build-dict.mjs` 会把这两个目录下所有 `*.json` 当词条数组校验，senses 表没有 `pos/gloss/level`
会直接把构建打挂。生成器从原型提升为 `scripts/import-senses.mjs`（新增 `npm run import:senses`），
与 `import-typewords.mjs` 对称；它仍需外部 TypeWords clone，但**产物入库后 `git clone` 即可构建**，
生成器只用于追溯与后续更新。来源写进 `data/imported/README.md`。

**Q2 存放 = 并进 `dict.zh.json`。** 每条词条新增可选字段 `senses: string[]`：`senses[0]` 恒等于该条的
`gloss`，其余为多义项；≤6 条、每条 ≤14 字、去重。**没有额外义项的条目（那 437 条）不写 `senses` 字段**，
单 gloss 条目体积不变。词典预计 192KB → 约 400KB，仍远小于任何模型。

**Q3 `gloss` 固定为首候选；噪声只做粗过滤。** 构建时强制 `senses[0] === gloss`，
保证「好的那一项永远在选项里」（原型反复强调）。噪声不靠黑名单，只丢掉明显非释义的：
不含中文、超过长度上限、纯符号/标点。`cancel → 邮票注销章/戳记` 这类保留，交给上下文判断。

**Q4 覆盖缺口。** 本次只覆盖 CET-4 那 2,602 词；437 条无多义项的缺口记为 spec 的已知限制，
补义项依赖 03 选定的 LLM 链路，现在补会返工 → 写进 map 的 Not yet specified。

**校验扩展（`build-dict.mjs`）**：senses 表的 key 必须是词表头词，不是则**构建失败**（符合本项目
fail-fast 的一贯做法）；词条的 `senses` 必须是非空字符串数组、每条 ≤14 字且含中文、去重、≤6 条、
且 `senses[0] === gloss`。

## 更正（实现时发现原数字是错的）

上面那条 **「每条 ≤14 字」是错的**，它是我从 `build-senses.mjs` 的 `MAX_CHARS = 10` 误推来的——
那个 10 限的是**单个「原子」**，而一个义项由最多 3 个原子用 `/` 连接而成，所以结构上限是 **32 字**。
实测现有表里有 25 条超过 14 字（最长 22）。

**不截断它们**：那是打分器训练与评测时用的同一批字符串，改了「71.8%」就不再对应任何确定的产物。
实际落地的校验按 32 字的上限走，见 `scripts/build-dict.mjs` 的 `checkSenses` 与 spec 的「数据」一节。
另：最终实现没有把 `senses` 并进 `dict.zh.json`（义项表由打分服务持有），所以 `senses[0] === gloss`
这条也一并作废。

**派生出的接口**：义项先验（`distilled-senses.json` 的真实用法排序）如何并入 → 新开票 08。

## 补注（同日发现并行实现后）

工作树里已实现的通路由**服务端持有义项表**（`serve.py` 直接读 `prototype/mt-align/senses.json`，
页内只发「句子 + 单词」），所以 **Q2「并进 `dict.zh.json`」在现行实现下不必要**，降级为条件决定：
只有把推理搬进页内（`SensePicker` 注释里预留的 ONNX/WebGPU 路线）才需要打包义项表 —— 见票 10。

**Q1（产物入库、可复现）反而更紧迫了**：`serve.py` 依赖的 `senses.json` 仍由被 gitignore 的
`.tmp-ref/TypeWords` 生成，`git clone` 后无法重建；而它已经是这条通路的**必需输入**。
Q1 的结论不变：把生成产物纳入 `data/senses/`，生成器提升到 `scripts/`。
