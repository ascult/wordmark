# wordmark 功能文档

## 一、标注引擎

### 1.1 CET 词匹配（Aho-Corasick）

多模式匹配引擎，一次遍历文本即可匹配所有 CET-4（3518 词）+ CET-6（2130 词）。

- **位置**：`src/content/matcher.ts`
- **算法**：Aho-Corasick 自动机（Trie + fail 指针），`search(text, wordBounds)` 返回 `MatchResult[] { word, index, endIndex }`
- **词边界过滤**：仅当匹配位置精确对齐 `Intl.Segmenter` 词分割边界时才接受，避免 "apple" 匹配 "pineapple" 中的 "apple"
- **构建**：`runReplacement()` 中构建 `patternMap: Map<baseWord, string[]>`，key 为 CET 词，value 为词形变化列表

### 1.2 词形变化（Inflector）

为每个 CET 基础词生成语法变化形式，用于匹配页面上的各种时态/单复数。

- **位置**：`src/content/inflector.ts` → `generateInflections(word)`
- **规则**：

| 变化 | 规则 | 示例 |
|------|------|------|
| 复数/三单 -s | word + "s" | look → looks |
| -es | 以 s/x/z/ch/sh/o 结尾 | pass → passes, watch → watches |
| -ies | 辅音 + y 结尾 | study → studies |
| 过去式 -ed | word + "ed" | look → looked |
| -ied | 辅音 + y 结尾 | study → studied |
| -d | 以 e 结尾 | like → liked |
| -ing | word + "ing" | look → looking |
| 双写辅音 | 长度 2-3 且辅音结尾 | run → running, run → runned |
| -ly 副词 | 以 le 结尾去 le+ly，以 e 结尾去 e+ly | simple → simply, independent → independently |

- **上下文**：生成的词形变化作为 patternMap 的 value 数组传入 Aho-Corasick

### 1.3 派生形态（Derivations）

30 种常见英语派生后缀，将被标注词识别为基础 CET 词并映射回去。

- **位置**：`src/content/inflector.ts` → `generateDerivations(word)`, `resolveDerivedWord(text)`
- **覆盖的后缀**：

| 类别 | 后缀 | 还原规则 | 示例 |
|------|------|----------|------|
| 名词 | -ness, -ment | 直接去后缀 | happiness→happy, achievement→achieve |
| 名词 | -tion, -sion, -ation, -ition, -ution | 去后缀 + e | creation→create, decision→decide |
| 名词 | -ence, -ency | 去后缀 + t | independence→independent |
| 名词 | -ance, -ancy | 去后缀 + e | performance→perform |
| 名词 | -ity | 去后缀 + e | creativity→creative |
| 名词 | -ism, -ship | 直接去后缀 | capitalism→capital, friendship→friend |
| 名词 | -ist | 直接去后缀 | artist→art |
| 形容词 | -able, -ible | 去后缀 + e | enjoyable→enjoy |
| 形容词 | -al, -ic, -ical | 去后缀 | national→nation, economic→economy |
| 形容词 | -ive | 去后缀 + e | creative→create |
| 形容词 | -ous, -ful, -less | 直接去后缀 | dangerous→danger, beautiful→beauty |
| 动词 | -ize, -ise | 去后缀 + e | realize→real |
| 动词 | -ify | 去后缀 + y | simplify→simplify→simpl... |
| 名词 | -er, -or | 去后缀（-or+e） | worker→work, actor→act |
| 形容词 | -est | 去后缀 + e | biggest→big |

- **两遍扫描**：`annotatePage()` 先以词形变化做第一遍匹配，找到页面上出现的 CET 词，再仅为这些词生成派生形态做第二遍匹配
- **回映射**：`derivedToBase` Map 记录派生词→基础词，batchTranslate 时把派生词的基础词也加入翻译列表
- **标注更新**：`updateAnnotation()` 将基础词的释义同步到所有派生词形标记

### 1.4 停用词过滤

过滤不应标注的极高频语法词和常见词。

- **位置**：`src/common/stop-words.ts`
- **数量**：96 个
- **分类**：
  - 冠词/代词/介词：a, an, the, and, to, of, in, it, is, be, he, she, we, they, you, i, my, me, our, us, or, no, at, by, on, for, with, as, but, so, if, her, his, their, your, its, not, am, are, was, were, been, do, does, did, has, had, have, this, that, these, those
  - 量词：every, many, much, some, any, few, little, more, most, all, even
  - 基础形容词：good, bad, big, small, new, old, high, low, long, short, own, other, another, same, such
  - 常见副词：only, just, very, too, also, still, now, then, here, there, well, back, down, way
- **机制**：Aho-Corasick 搜索结果通过 `STOP_WORDS.has(m.word)` 过滤

### 1.5 用户词汇参与标注

用户在单词本中添加的自定义词同样参与页面标注。

- **位置**：`src/content/engine.ts` → `buildVocabInfoMap()`
- **机制**：`vocabList` 中的每个 entry 加入 infoMap，`source: "custom"`，使用用户输入的 `definition`
- **停用词过滤**：自定义词也经过 STOP_WORDS 过滤
- **定义优先级**：自定义词在 infoMap 中有 predefined definition，不需要 Bing 翻译
- **同步时机**：
  - 页面加载时 `init()` 读取当前 vocabList
  - `storage.onChanged` 检测到 vocabList 变更时重新标注
  - `vocab-updated` 消息触发时刷新

### 1.6 页面段提取

从页面提取文本段落，供 Bing 翻译使用。

- **位置**：`src/content/engine.ts` → `getPageSegments()`
- **目标元素**：`p, h1-h6, li, td, th, blockquote, figcaption, caption`
- **合并规则**：相邻块合并到 ~500 字符上限
- **数量上限**：最多 20 段
- **去重**：相同的段只保留一个
- **过滤**：跳过 checklist `<li>`（含 `<input>` 的元素），跳过 ≤5 字符的纯短文本

---

## 二、翻译管道

### 2.1 Bing 分段翻译

每个段单独发 Bing 请求，克服单次 950 字符限制。

- **位置**：`src/background/translator.ts` → `batchTranslate()`, `translateSegment()`
- **并发数**：`CONCURRENCY = 3`，每批 3 段并行
- **早停机制**：连续 3 批（9 段）无任何结果则提前终止，剩余词走词典 fallback
- **段过滤**：仅翻译包含未处理词的段，已处理词跳过
- **字符限制**：单段超过 950 字符截断

#### Bing API 调用

- **位置**：`src/background/bing.ts`
- **流程**：从 `bing.com/translator` 页面提取 token（IG、IID、key、token）→ POST 到区域 `ttranslatev3`
- **Token 刷新**：HTTP 429 或过期时重新提取
- **响应处理**：可能是 JSON 或 HTML（gender debiasing），按 Content-Type 解析

### 2.2 段缓存

翻译结果按段 hash 缓存，避免重复请求。

- **位置**：`src/background/translator.ts` → `hashSegment()`, `segmentCache`
- **TTL**：1 小时（`CACHE_TTL = 60 * 60 * 1000`）
- **Key**：段文本的 DJB2 hash（36 进制）
- **范围**：Service Worker 内存内（SW 终止则清空）

### 2.3 句子对齐

中英文句子按索引对齐，用于从 Bing 翻译中找出单个词的中文对应。

- **位置**：`src/background/sentence.ts`
- **分句**（`splitSentences`）：英文按 `. ! ?` 断句，中文按 `。！？；`
- **对齐**（`buildWordSentenceMap`）：按索引 1:1 对齐，多余句子附到最后一句
  - 英文多 → 多余英文句都映射到最后一句中文
  - 中文多 → 多余中文句追加到对应的英文句映射值

### 2.4 中文匹配（findClosestMatch）

从中文句子中选出最合适的中文词。

- **位置**：`src/background/sentence.ts` → `findClosestMatch()`
- **三级匹配**：

| 级别 | 策略 | 精度 |
|------|------|------|
| 1. 位置匹配 | cn[] 词在中文句子中的 indexOf 位置与英文词位置比例对齐 | 高 |
| 2. 字符匹配 | cn[] 词中各字符在中文句子中的覆盖率排序 | 中 |
| 3. 字符切片 | 按估算位置切 1-3 个中文字符 | 低 |

- **质量过滤**：仅接受级别 1 的匹配（`entry.cn.includes(matched)`），拒绝切片结果
- **Fallback**：匹配失败 → `entry.cn[0]` → `entry.def`

### 2.5 词典 Fallback

Bing 失败或无匹配时使用词典。

- **Fallback 策略**：优先 `entry.cn[0]`（预提取的干净中文词），其次 `entry.def`（完整词典释义）
- **词典结构**：`dict.json`（1.2MB），格式 `{word: {def: string, cn: string[]}}`
- **翻译**（右键菜单）：`translate(word)` 返回 `entry.def`，即完整词典释义（含词性标注）
- **批量**（页面标注）：`batchTranslate` 返回 `cn[]` 干净中文，不展示英文语法标签

---

## 三、页面交互

### 3.1 全局开关

即时启用/禁用当前页面的所有标注。

- **键盘快捷键**：`Alt+W` 切换（`src/manifest.json` → `commands.toggle-replacement`）
- **Popup 开关**：`src/popup/popup.ts` → `#global-toggle` checkbox
- **机制**：`chrome.runtime.sendMessage({ type: "toggle-replace", payload: enabled })` → content script 调用 `runReplacement()` 或 `undoReplacement()`
- **undoReplacement**：遍历所有 `.wm-annotated` mark 元素，用 `data-original` 属性恢复原始文本

### 3.2 CET-4/CET-6 独立开关

分别控制 CET-4 和 CET-6 词是否标注。

- **位置**：`src/popup/popup.ts` → `#cet4-toggle`, `#cet6-toggle`
- **机制**：修改 `settings.cet4Enabled` / `settings.cet6Enabled` → 触发 `vocab-updated` → 重新标注
- **计数**：Popup 显示各等级词数（CET-4: 3518, CET-6: 2130）

### 3.3 弹窗命中数

打开 Popup 时实时显示当前页面标注的词数。

- **位置**：`src/popup/popup.ts` → `updateMatchCount()`
- **机制**：`chrome.tabs.sendMessage(tabId, { type: "get-match-count" })` → 内容脚本统计 `mark.wm-annotated` 数量
- **错误处理**：无法获取时显示 "—"

### 3.4 动态内容检测（MutationObserver）

SPA、无限滚动、懒加载等动态内容自动标注。

- **位置**：`src/content/index.ts` → `setupMutationObserver()`
- **监听对象**：`document.body`, `childList: true, subtree: true`
- **防抖**：500ms 内连续变更只触发一次
- **安全**：`walkTextNodes()` 跳过 `.wm-annotated` 元素内的文本节点，不会重复标注

### 3.5 防重入锁

防止 storage.onChanged 与 MutationObserver 同时触发重复的 batch-translate 调用。

- **位置**：`src/content/index.ts` → `batchInProgress` 标志
- **机制**：`runReplacement()` 检查 `!batchInProgress` 才调用 `fetchBatchDefinitions()`，`finally` 中重置
- **标注不受影响**：锁只阻止重复的 Bing 翻译，不阻止 `replaceMatches`（创建空标记）

### 3.6 标注格式

- **元素**：`<mark class="wm-annotated" data-original="word" style="background-color: #fff3cd;">word(释义)</mark>`
- **初始状态**：`mark.textContent = original`（无括号，空标记）
- **翻译后**：`mark.textContent = "original(definition)"`
- **定义来源优先级**：Bing 上下文匹配 > 自定义词汇定义 > 词典 cn[0] > 词典 def

---

## 四、站点控制

### 4.1 白名单/黑名单

按域名控制标注生效范围。

- **位置**：`src/content/dom-walker.ts` → `isDomainAllowed(settings)`
- **逻辑**：
  - 白名单非空 → 仅白名单域名生效
  - 白名单空 + 黑名单非空 → 黑名单域名不生效
  - 白名单空 + 黑名单空 → 全域名生效
- **子域名匹配**：`hostname.endsWith("." + domain)` 支持 `sub.example.com` 匹配 `example.com`
- **管理界面**：Options 页 → 站点设置（`src/options/options.ts`）

---

## 五、管理界面

### 5.1 单词本管理

- **位置**：`src/options/options.ts`, `src/options/index.html`
- **功能**：搜索、编辑、删除自定义词汇
- **存储**：`chrome.storage.local` → `vocabList` 键
- **数据模型**：`VocabularyEntry { id, word, definition, createdAt }`

### 5.2 导入/导出

- **格式**：JSON 和 CSV 双格式
- **JSON**：`[{word: string, definition: string}, ...]`
- **CSV**：`word,definition` 表头，逗号分隔
- **触发**：Popup 和 Options 页均有导入/导出按钮
- **去重**：导入时按标准化词（小写去空格）去重

### 5.3 右键菜单

选择页面文本 → 右键 → "添加到单词本" → 自动翻译并保存。

- **位置**：`src/background/context-menu.ts`
- **流程**：提取选中文本 → `normalizeWord()` → `translate(word)` → `addWord()` → `vocab-updated` 通知内容脚本

---

## 六、数据结构

### 6.1 存储结构（chrome.storage.local）

```typescript
{
  vocabList: VocabularyEntry[],   // 用户自定义词汇
  settings: {
    enabled: boolean,             // 全局启用
    cet4Enabled: boolean,         // CET-4 开关
    cet6Enabled: boolean,         // CET-6 开关
    whitelist: string[],          // 白名单域名
    blacklist: string[],          // 黑名单域名
    importSampleDone: boolean,    // 是否已导入示例
  }
}
```

### 6.2 消息协议

| 消息类型 | 发送方 | 接收方 | 数据 | 响应 |
|----------|--------|--------|------|------|
| `toggle-replace` | Popup/SW | Content script | `payload: boolean` | — |
| `vocab-updated` | Popup/Context menu | Content script | — | — |
| `get-match-count` | Popup | Content script | — | `{ count: number }` |
| `fetch-translation` | Context menu | SW | `{ word: string }` | `{ definition: string }` |
| `batch-translate` | Content script | SW | `{ words: string[], segments: string[] }` | `{ definitions: Record<string, string> }` |

---

## 七、工程结构

### 7.1 源文件结构

```
src/
├── manifest.json
├── test-page.html
├── background/
│   ├── service-worker.ts    — 消息路由、命令、生命周期
│   ├── bing.ts              — Bing Translate API
│   ├── translator.ts        — translate(), batchTranslate() 公开 API
│   ├── sentence.ts          — 纯函数：分句、对齐、中文匹配
│   ├── storage.ts           — chrome.storage.local CRUD
│   └── context-menu.ts      — 右键菜单
├── content/
│   ├── index.ts             — 入口：状态管理、MutationObserver、消息路由
│   ├── engine.ts            — 标注引擎、段提取
│   ├── matcher.ts           — Aho-Corasick 实现
│   ├── inflector.ts         — 词形变化、派生形态
│   ├── replacer.ts          — DOM 替换（requestIdleCallback 分块）
│   ├── dom-walker.ts        — TreeWalker 文本节点遍历、域名过滤
│   └── tokenizer.ts         — Intl.Segmenter 词边界
├── common/
│   ├── types.ts             — 类型定义
│   ├── constants.ts         — 默认设置、常量
│   ├── utils.ts             — generateId, normalizeWord
│   ├── dict.ts              — 词典导入 + lookup()
│   ├── dict.json            — 1.2MB 预提取词典
│   ├── cet4.ts / cet6.ts    — CET 词表
│   ├── stop-words.ts        — 停用词表（96 词）
│   └── sample-vocab.ts      — 示例词汇
├── popup/                   — 弹窗（启停开关、导入导出）
└── options/                 — 设置页（单词本管理、域名管理）
```

### 7.2 构建

| 项 | 工具 | 输出 |
|------|------|------|
| 打包 | esbuild | `dist/background/service-worker.js` (2.2MB), `dist/content/index.js` (87KB) |
| 类型检查 | tsc --noEmit | — |
| 测试 | vitest + jsdom | 91 tests, 7 test files |
| 浏览器测试 | Playwright + Chromium | 本地页面 + 真实页面 |

### 7.3 依赖图

```
content/index.ts
  ├── engine.ts
  │   ├── matcher.ts
  │   ├── inflector.ts
  │   ├── replacer.ts → dom-walker.ts, tokenizer.ts
  │   ├── common/cet4.ts, common/cet6.ts, common/stop-words.ts
  │   └── common/types.ts
  ├── dom-walker.ts
  └── background/storage.ts

background/translator.ts
  ├── bing.ts
  ├── common/dict.ts → dict.json
  └── sentence.ts (纯函数，零依赖)
```
