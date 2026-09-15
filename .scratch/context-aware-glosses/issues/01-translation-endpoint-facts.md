Type: research
Status: resolved
Blocked by: 无

## Question

运行态要拿到「整句/整段翻译」作为定位词典义的输入，可用接口有哪些、能力与限制如何？

需要回答：

1. 现有扩展里的 **MyMemory** provider 是否支持整句/整段（而不是单词）翻译？返回结构是什么、
   限流几何、是否需要 key、隐私条款如何？
2. 现有 `custom` provider 的契约（https 模板含 `{word}` 占位符 + 释义字段点路径，如 `data.0.gloss`）
   能否承载整句翻译？如果不能，协议要怎么改（占位符换成 `{text}`？返回里是否需要源文片段对齐？）。
3. 局域网/本机 **OpenAI 兼容端点**（prototype 里 laptop 的 llama.cpp CUDA 服务、或 Mac 上的 MLX）
   作为整句翻译源：延迟、批处理能力（一次多句）、上下文长度、可达性（`127.0.0.1` vs 局域网 IP）。
   注意 Chrome MV3 扩展对 `http://localhost` / 私网地址的 host permission 限制。

产出：一张「接口 → 能力/成本/限流/隐私」的事实清单，写进本票的 `## Answer`，并把原始来源记下。
不要在此票里选型——选型是 03 的事。

## Answer

事实清单全文见 `research/01-translation-endpoints.md`（460 行，逐条引用来源）。要点：

**MyMemory**（`mymemory.translated.net/doc/spec.php`，经 2024-12-18 的 Internet Archive 快照读取；API 本身实测）
- 接受**整句**，上限 500 字符（804 字节查询返回 `403 QUERY LENGTH LIMIT EXCEEDED`）；ToS 明确禁止「一次翻译超过一段」。
- 响应含 `responseData{translatedText, match}`、`matches[]{segment, translation, quality, match, penalty}`，
  但**对齐只到 TM 条目粒度**——MT 条目的 `segment` 就是整条查询，**没有子句级对齐**，也没有批量参数。
- 限额：匿名 5,000 字符/天；留有效邮箱 50,000；白名单 150,000。**不需要 key**。
- 隐私：提交内容长期存储、共享给外部 MT 供应商/合作方。

**现有扩展契约载不了句子**：`{word}` 占位符、自定义地址强制 https（`src/dict/remote.ts:29-37`，
`src/options/options.ts:247-256`）；查询正则 `^[a-z']+$`（`remote.ts:119`）；响应只取一个标量点路径
（`remote.ts:40-58,160-165`）；`sanitizeGloss` 截 24 字并要求含中文（`remote.ts:17,75,78`）；
`LookupResult` 与消息协议无任何译文/对齐字段（`src/core/types.ts:58-72`、`src/core/messages.ts:25-34`）。
承载句子需要的改动面：新占位符、放宽校验、http 主机权限、结构化响应、单独的句子清洗器、新消息类型、句级缓存键。

**Chrome MV3 可访问本地/局域网**：匹配模式明确支持 `http://localhost/*` 与 `http://127.0.0.1/*`（端口默认通配）；
局域网 IP 无 CIDR 写法，需字面量或 `http://*/*`；`host_permissions` 装时生效，`optional_host_permissions`
运行时经 `chrome.permissions.request` 申请。Chrome 的 LNA 采用指南明确：**LNA 不适用于扩展，有主机权限的
扩展可以做本地网络请求**。仓库目前只声明 https（`src/manifest.json:42`），所以 http/本地现在够不到。

**本地 OpenAI 兼容端点**：llama.cpp 的 `/completion` 接受 **prompt 数组**（一次多句），默认连续批处理；
MLX `mlx_lm.server` 一次请求只收一个 prompt（批处理靠并发），默认 `127.0.0.1:8080`。
仓库实测 9B：laptop 首 308ms / 命中提示缓存 97ms，一次 6 句 12/12、约 0.75 秒/句；M4 首 9166ms / 后续 809ms。
跨机用 loopback 需隧道或 `--host 0.0.0.0`。
