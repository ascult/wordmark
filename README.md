# wordmark

将网页中的生词自动内联替换为英文→中文释义，帮助保持阅读流。

## 功能

- **单词本管理**：存储与管理个人词库，支持搜索、编辑、删除、导入/导出（JSON/CSV）
- **右键标记**：选中网页中的英文单词，右键菜单"添加到单词本"，自动获取中文释义
- **页面替换引擎**：全词匹配 + 屈折形态支持，自动将已标记单词在网页中替换为 `原词(释义)` 并添加浅黄色高亮
- **替换控制**：全局开关、键盘快捷键（`Alt+W`）
- **内置测试页**：通过 Popup "打开测试页" 按钮，在 `chrome-extension://` 页面中验证替换效果
- **示例词库**：200 词 CEFR B1-B2 级别内置示例

## 快速开始

```bash
git clone <repo-url>
cd wordmark
npm install
```

### 构建与加载

```bash
npm run build      # 构建到 dist/
npm run watch      # 监听模式
```

打开 Chrome → `chrome://extensions/` → 开启开发者模式 → "加载已解压的扩展程序" → 选择 `dist/` 目录。

### 测试

```bash
npm test           # 68 tests
npm run test:watch # 监听模式
```

## 技术栈

| 项目 | 选型 |
|------|------|
| 平台 | Chrome Extension Manifest V3 |
| 语言 | TypeScript |
| 构建 | esbuild |
| 测试 | Vitest + jsdom |
| 存储 | `chrome.storage.local` |
| 匹配算法 | Aho-Corasick 自动机 |
| 翻译 | MyMemory API（免费，免 Key） |

## 项目结构

```
wordmark/
├── src/
│   ├── manifest.json
│   ├── background/         # Service Worker
│   │   ├── service-worker.ts
│   │   ├── context-menu.ts
│   │   ├── storage.ts
│   │   └── translator.ts
│   ├── content/            # 替换引擎
│   │   ├── index.ts
│   │   ├── matcher.ts      # Aho-Corasick
│   │   ├── inflector.ts    # 屈折形态
│   │   ├── dom-walker.ts
│   │   └── replacer.ts
│   ├── popup/              # 扩展弹窗
│   │   ├── index.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── options/            # 单词本管理
│   │   ├── index.html
│   │   ├── options.ts
│   │   └── options.css
│   ├── common/
│   │   ├── types.ts
│   │   ├── constants.ts
│   │   ├── utils.ts
│   │   └── sample-vocab.ts # 200 词 CEFR B1-B2 示例
│   ├── icons/
│   │   └── icon.svg
│   ├── test-page.html      # 内置测试页
│   └── __tests__/
│       ├── setup.ts        # chrome mock
│       ├── utils.test.ts
│       ├── inflector.test.ts
│       ├── matcher.test.ts
│       ├── storage.test.ts
│       ├── dom-walker.test.ts
│       └── replacer.test.ts
├── .agents/                # 开发技能
│   └── skills/
│       ├── extension-real-browser-testing/
│       └── extension-perf-forensics/
├── vitest.config.ts
├── esbuild.config.mjs
├── tsconfig.json
└── package.json
```

## 许可

GNU General Public License v3.0
