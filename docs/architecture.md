# 技术架构文档 — wordmark

> 基于 Chrome Extension Manifest V3

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                    Chrome Extension                           │
│                                                              │
  │  ┌──────────────┐    ┌──────────────────┐                    │
  │  │  background   │    │    content_script │                    │
  │  │  (SW)         │◄──►│    (替换引擎)     │                    │
  │  │               │    │                  │                    │
  │  │ 右键菜单管理   │    │ Aho-Corasick     │                    │
  │  │ 存储访问      │    │ DOM 遍历/替换    │                    │
  │  │ 翻译 API 调用 │    │ storage.onChanged │                    │
  │  └──────┬───────┘    └────────┬─────────┘                    │
│         │                     │                              │
│         │     ┌───────────────┴───────────────┐              │
│         │     │           popup                │              │
│         │     │  (扩展弹窗 / 单词本管理)       │              │
│         │     └───────────────┬───────────────┘              │
│         │                     │                              │
│         └─────────┬───────────┘                              │
│                   │                                          │
│         ┌─────────▼──────────┐                               │
│         │  chrome.storage    │                               │
│         │  .local            │                               │
│         └────────────────────┘                               │
└──────────────────────────────────────────────────────────────┘
```

### 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **background** | `src/background/service-worker.ts` | Service Worker，管理右键菜单、存储读写、翻译 API 调用 |
| **content_script** | `src/content/index.ts` | 替换引擎入口，监听 storage.onChanged 和 runtime.onMessage |
| **popup** | `src/popup/` | 扩展弹窗 UI，全局控制入口 |
| **options** | `src/options/` | 完整单词本管理页（搜索/编辑/删除/导入导出） |
| **common** | `src/common/` | 共享类型定义、工具函数、常量 |

---

## 2. 目录结构

```
src/
├── manifest.json                    # 扩展配置 (MV3)
├── background/
│   ├── service-worker.ts            # 入口
│   ├── context-menu.ts              # 右键菜单管理
│   ├── storage.ts                   # chrome.storage 封装
│   └── translator.ts                # 翻译 API 调用（占位）
├── content/
│   ├── index.ts                     # 入口，消息监听
│   ├── matcher.ts                   # Aho-Corasick 实现
│   ├── inflector.ts                 # 屈折形态变换
│   ├── dom-walker.ts                # DOM 遍历与过滤
│   └── replacer.ts                  # 文本替换逻辑
├── popup/
│   ├── index.html
│   ├── popup.ts
│   └── popup.css
├── options/
│   ├── index.html
│   ├── options.ts
│   └── options.css
├── common/
│   ├── types.ts                     # 共享类型
│   ├── constants.ts                 # 常量
│   ├── utils.ts                     # 工具函数
│   └── sample-vocab.ts              # 200 词 CEFR B1-B2 示例词库
├── icons/
│   └── icon.svg
├── test-page.html                   # 内置测试页
└── __tests__/                       # 单元测试
    ├── setup.ts                     # chrome API mock
    ├── utils.test.ts
    ├── inflector.test.ts
    ├── matcher.test.ts
    ├── storage.test.ts
    ├── dom-walker.test.ts
    └── replacer.test.ts
```

---

## 3. 数据流

### 3.1 页面替换流程

```
用户打开网页
    │
    ▼
content_script 注入 (manifest.json 配置)
    │
    ▼
读取 chrome.storage.local 获取 vocabList 和 settings
    │
    ├── settings.enabled === false? ──► 不执行，退出
    │
    ▼
构建 Aho-Corasick 自动机 (vocabList → pattern)
    │
    ▼
requestIdleCallback 遍历 DOM 文本节点
    │
    ▼
匹配 → 替换为 `原词(释义)` + 包裹 <mark> 高亮
```

### 3.2 添加单词流程

```
用户选中文本 → 右键菜单
    │
    ▼
background: context-menu.ts 接收点击事件
    │
    ▼
background: translator.ts 调用翻译 API
    │
    ├── 成功? ──► 打开弹窗，显示翻译结果供确认
    │
    └── 失败? ──► 显示错误提示，提供重试
    │
    ▼
用户确认 → background: storage.ts 写入 vocabList
    │
    ▼
chrome.storage.onChanged 触发 → content_script 重新执行替换
```

### 3.3 全局开关流程

```
用户点击 Popup 开关
    │
    ▼
popup → chrome.storage.local 更新 settings.enabled
    │
    ▼
chrome.storage.onChanged 触发 content_script
    │
    ├── enabled === true? ──► 执行替换
    │
    └── enabled === false? ──► 撤销替换（恢复原始文本）
```

---

## 4. 核心模块设计

### 4.1 Aho-Corasick 自动机 (`src/content/matcher.ts`)

用于一次扫描文本即可匹配所有单词，时间复杂度 O(n + m)。

```typescript
interface ACNode {
  children: Map<string, ACNode>;
  fail: ACNode | null;
  output: string[];  // 匹配到的单词（含屈折变体）
}

class AhoCorasick {
  private root: ACNode;

  constructor(patterns: string[]);
  search(text: string): MatchResult[];
}
```

- 每个节点的 `output` 存储该位置匹配到的原形词 ID
- 构建时同时将屈折变体加入 Trie

### 4.2 屈折形态支持 (`src/content/inflector.ts`)

```typescript
function generateInflections(word: string): string[];
// look → [look, looks, looked, looking]
// apple → [apple, apples]
```

规则覆盖：
- 名词复数：`-s`, `-es`, `-ies`
- 动词第三人称：`-s`, `-es`, `-ies`
- 动词过去式：`-ed`, `-ied`
- 动词现在分词：`-ing`
- 不规则词根需手动补充（后续版本）

### 4.3 DOM 遍历 (`src/content/dom-walker.ts`)

```typescript
function walkTextNodes(root: Node): TextNodeInfo[];
```

- 使用 `TreeWalker` 遍历所有文本节点
- 跳过 `script`, `style`, `textarea`, `input`, `svg` 等标签
- 对每个文本节点记录 `{ node, text, offset }`

### 4.4 文本替换 (`src/content/replacer.ts`)

```typescript
function replaceMatches(
  root: Document,
  matches: MatchResult[],
  vocabMap: Map<string, VocabularyEntry>
): void;
```

- 对每个匹配创建 `<mark>` 元素，内容为 `原词(释义)`
- 添加 CSS 类 `wm-annotated`（浅黄色背景 `background: #fff3cd`）
- 使用 `requestIdleCallback` 分片处理，避免阻塞主线程

### 4.5 存储封装 (`src/background/storage.ts`)

```typescript
async function getVocabList(): Promise<VocabularyEntry[]>;
async function addWord(word: string, definition: string): Promise<void>;
async function removeWord(id: string): Promise<void>;
async function updateWord(id: string, updates: Partial<VocabularyEntry>): Promise<void>;
async function getSettings(): Promise<Settings>;
async function updateSettings(updates: Partial<Settings>): Promise<void>;
```

### 4.6 翻译 API (`src/background/translator.ts`)

```typescript
async function translate(word: string): Promise<string>;
```

- 封装 MyMemory API（免费，免 Key）
- 超时处理（5s 超时）
- 指数退避重试（最多 3 次）
- 返回中文释义字符串

---

## 5. Chrome Extension 配置

### manifest.json 要点

```json
{
  "manifest_version": 3,
  "name": "wordmark",
  "version": "0.1.0",
  "permissions": [
    "storage",
    "contextMenus",
    "activeTab",
    "scripting"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background/service-worker.js"
  },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content/index.js"],
    "run_at": "document_idle"
  }],
  "action": {
    "default_popup": "popup/index.html",
    "default_title": "wordmark"
  },
  "options_page": "options/index.html",
  "commands": {
    "toggle-replacement": {
      "suggested_key": {
        "default": "Alt+W"
      },
      "description": "Toggle word replacement on current page"
    }
  }
}
```

---

## 6. 性能优化

- **Aho-Corasick 自动机**：一次扫描 O(n) 匹配所有单词，而非逐词正则匹配 O(n×k)
- **requestIdleCallback**：分段处理 DOM 节点，避免长任务阻塞
- **缓存自动机**：单词本未变化时复用已构建的自动机
- **DOM 批量替换**：合并同一文本节点的多个匹配，减少重排

---

## 7. 消息通信

| 消息 | 方向 | 用途 |
|------|------|------|
| `vocab-updated` | background → content (fallback) | 单词本变更，通知重新替换（主流程走 storage.onChanged） |
| `toggle-replace` | popup → content (fallback) | 全局开关变更（主流程走 storage.onChanged） |
| `get-match-count` | content → popup | 返回当前页命中数 |
| `translate-word` | content → background | 请求翻译 API |

---

## 8. 测试

### 8.1 测试框架

- **Vitest** + **jsdom** 环境
- **chrome API mock**：`src/__tests__/setup.ts` 提供全局 `chrome.*` mock
- 运行：`npm test`（68 用例，6 文件）/ `npm run test:watch`（监听）

### 8.2 测试覆盖

| 模块 | 文件 | 用例数 | 验证内容 |
|------|------|--------|----------|
| `utils.ts` | `utils.test.ts` | 3 | normalizeWord 大小写/空格 |
| `inflector.ts` | `inflector.test.ts` | 15 | 复数/过去式/分词/双写规则 |
| `matcher.ts` | `matcher.test.ts` | 14 | AC 构建、搜索、重叠匹配、批量模式 |
| `storage.ts` | `storage.test.ts` | 16 | CRUD、导入/导出、设置读写、缺省值 |
| `dom-walker.ts` | `dom-walker.test.ts` | 7 | 域名过滤（已移除黑白名单）、常规行为 |
| `replacer.ts` | `replacer.test.ts` | 11 | DOM 替换、标签跳过、高亮样式 |

### 8.3 Mock 策略

- `chrome.storage.local` — 内存对象模拟，测试间可重置
- `window.location` — `Object.defineProperty` 覆写 hostname
- DOM 操作 — jsdom 提供完整 DOM API
