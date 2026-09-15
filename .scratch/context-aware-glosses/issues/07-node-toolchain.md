Type: task
Status: resolved
Blocked by: 无

## Question

让这个仓库重新「跑得起来」，这是后面任何验证的前置。

要做：

1. 安装 Node.js ≥ 20（本机 `node` 不在 PATH，`/opt/homebrew/bin`、nvm、volta 都没有；
   但 `package-lock.json`、`dist/` 存在，说明以前用过）。
2. `npm install`，然后让 `npm run check` 全绿：
   `dict → typecheck → lint → test → build:prod → validate → smoke → smoke:ui`。
3. 附带决定：是否先把当前**未纳管的工作树**做一次基线提交——`git ls-files` 只有 `LICENSE` 和
   `README.md`，`src/`、`tests/`、`scripts/`、`data/`、`prototype/` 全是 untracked。
   没有基线，就没有回滚点，后面任何「产物级验证」都缺一层保障。

闭票时记录：Node 版本与安装方式、`npm run check` 的结果、基线提交做了没有（若做了给出 commit）。

## Answer

环境恢复完成，并顺带修掉一个真实缺陷。

**Node**：由 `fnm` 管理，**v24.21.0**（npm 11.19.0），位于
`~/.local/share/fnm/node-versions/v24.21.0/installation/bin/`。它**不在登录 shell 的 PATH 里**
（`zsh -lic 'command -v node'` 也找不到），所以任何 `npm run …` 都必须先把该 bin 目录加进 PATH。
仓库没有 `.nvmrc` / `.node-version`；`node_modules/` 已存在（118MB）。

**`npm run check` = 通过（EXIT=0）**：
- `dict`：合并 3,039 条 → `src/data/dict.zh.json`（curated 747 + imported/cet4 2,292，跳过 340 条重复）
- `typecheck`、`lint` 通过
- `test`：15 个文件 / **164 个用例全过**
- `build:prod` → `dist/` v0.1.0（minified）
- `validate`：manifest 自洽、资源齐全、无动态代码
- `smoke`：真实 `dist/content.js` 完成 4 处标注
- `smoke:ui`：options 21 项 + popup 14 项断言全过，无未捕获异常

**发现并修复的缺陷（影响面远不止类型检查）**：`src/content/index.ts:63` 的在线查词代理
把 `sendRequest` 的 `{ok, data}` 信封当成已解包数据取 `data.result`，**永远得到 `undefined`**——
「在线查词」这条路径此前**完全失效**（恒返回 null），只是被 typecheck 先拦下才没跑到运行时。
已改为 `data.ok ? data.data.result : null`。这是**行为变更**：修好后开启在线兜底才会真正发请求。
该文件正是本 effort 的 03/04 要动的代码路径，实现时必须知道这一点。
建议补一条回归测试（`sendRequest` 的 `{ok:false}` 分支）。

**基线提交：未做，交用户决定。** 现在 `git ls-files` 只有 `LICENSE` 与 `README.md`，其余全 untracked。
没有基线就没有回滚点，后面每个实现动作都缺一层保障。但**首次提交前必须先扩 `.gitignore`**：
`.gitignore` 目前只忽略 `dist/ node_modules/ .tmp-*/ *.log` 等，而 `prototype/mt-align/` 下有
**945MB 的 `xenc/scorer.safetensors`**、两个 17MB 的 `adapters*/`、16MB 的 `features.npz`——
直接 `git add -A` 会把这些二进制灌进仓库。另需确认 `.agents/`（26 个 vendored 技能）是否随仓库走。
