Type: grilling
Status: resolved
Blocked by: 无

## Question

评测怎么设计？这一章要回答「比现在的首义项到底好多少」，否则 spec 交付后无法验收。

要定：

- **指标**：义项级准确率怎么定义（与人工判定的语境义是否一致？top-1 / top-2？）；
  是否保留「与译文相容率」作为置信度信号而不是准确率（原型已警告它被系统性低估）。
- **人工小集**：规模（几十句？几百句？）、抽样来源（现有 6 篇 bench 文章？`dataset-v2` 的 2675 条？）、
  标注口径（谁标、遇到歧义怎么办、`义项先验` 与语境义冲突时以谁为准）。
- **teacher 对照**：teacher 全文翻译在评测里的角色——构造译文、还是断定义项对错；
  已知 teacher 与方法一致率 71%，不能当 ground truth。
- **基线**：对比「永远取首义项」（基线 55% teacher 一致率）与「按真实用法频次排序」（70%）。
- 复用现有 `article-bench` / `try-article` 台子，还是新建一个义项级跑法。

## Answer

用户委托我决策。**评测分两层：绝对质量用人工集，相对排序用 teacher 代理集，两者绝不混报。**

**1) 绝对质量：人工义项级小集（ground truth）**
- 规模 150–200 条。抽样：从 `.tmp-articles/` 那 6 篇缓存文章 + `prototype/mt-align/dataset-v2` 里挑
  「多义项词」的句子，按难度分层（cet4/cet6/ielts/gre 各占一定比例），词不重复、每词 1–2 句，固定随机种子。
- 格式 `data/eval/sense-gold.jsonl`，每条 `{id, word, sentence, senses[], gold}`；`senses` 就是 02 定下的
  生产形状（`[gloss, ...extras]`），`gold` 是义项下标，另有 `"none"` 表示「这句没有合适义项 / 不需标注」。
- 标注：单人（项目所有者）盲标——只按句子判断、不看得哪个机制产出的；口径先写死（歧义取最接近的，
  实在不行选 none）；抽 20% 重标，报告自洽率。

**2) 相对排序：teacher 标签的大规模代理集（不是准确率）**
- 复用 `dataset-v2`（2,675 条 / 693 词，每条带 `shuffledSenses` 与 teacher `target`）廉价排序各机制。
- 两条已知噪声必须写进报告：标签来自 teacher（交叉校验显示 teacher 与方法一致率仅 71%，**一致 ≠ 正确**）；
  句子边界质量差（样例里 `create` 的「句子」混着导航文字 `Manage Edit Post Logout`）。
- 它只回答「A 比 B 好」，不准写成「准确率 X%」。

**3) 指标**：主指标人工集 `top1`；辅以人工集 `top2`（候选集本身是否含对的）、`coverage`、`fallback_rate`、
`locate_rate`（方法定位率）、`llm_call_rate`、`latency p50/p95`、`cache_hit_rate`。「与译文相容率」
只作**置信度信号**，不作准确率（原型已警告它被系统性低估）。现有 `article-bench` 的 coverage / integrity
继续跑，作为「别把产品搞坏」的底线。

**4) 对照基线（同一套集子跑）**：(a) 永远首义项（= `senses[0] === gloss`，现状）(b) 义项先验排序第一项
(c) 方法定位 (d) 方法 + LLM 补位 (e) 纯 LLM 挑选。这五个正好对应 03 待选的链路——所以
**评测台可以先于 03 建好，并反过来给 03 供数**。

**5) 台子**：新建 `scripts/sense-eval.mjs`（`npm run eval:sense`），沿用 article-bench 的表格 /
`--save` / `--compare` 约定与 `.tmp-articles/` 语料；`--strategy=` 选基线；**网络与 LLM 调用落盘缓存、
默认 replay**，无网可复现、可进 CI。`article-bench` 不动。

**6) 验收线（写进 spec）**：只有人工集上的 `top1` 提升（相对「永远首义项」，配对 bootstrap）其 95% 置信区间
**不含 0**，才允许作为默认行为上线；提升幅度按实测写进 spec，不预设数字。150–200 条的样本量即来自
「配对比较下能分辨约 10pp 差异」这一考量。
