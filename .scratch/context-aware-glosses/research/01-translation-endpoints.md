# 01 — Sentence/paragraph translation interfaces: facts

Ticket: `.scratch/context-aware-glosses/issues/01-translation-endpoint-facts.md`
Question: to locate a dictionary sense inside a sentence's translation at runtime, what interfaces can
provide **sentence/paragraph translation**, and what are their capabilities and limits?

Scope: facts and trade-offs only. No provider is chosen and no architecture is recommended here
(selection is ticket 03). Every claim cites a source, either a URL (primary docs / live API) or a repo
file with line numbers. "Live probe" = request issued to the real endpoint on 2026-09-13 from this
machine via a local HTTP proxy.

---

## 1. MyMemory

Canonical docs: <https://mymemory.translated.net/doc/spec.php>. The live page returned HTTP 403 to
non-browser clients from this machine, so the spec was read from the Internet Archive snapshot of
that exact URL (capture `20241218125605`, i.e. 2024-12-18). Live API probes against
`https://api.mymemory.translated.net/get` succeeded and are quoted separately.

### 1.1 Does it accept sentences/paragraphs instead of single words?

**Yes, it accepts a sentence up to 500 bytes/chars; it is not word-only.**

- Spec, `Get` parameter table: `q` = "The sentence you want to translate. Use UTF-8. Max 500 bytes",
  Mandatory. (`spec.php`)
- Live probe, 2-sentence / 93-byte query
  `"The quick brown fox jumps over the lazy dog. This is a second sentence to test paragraph handling."`
  returned HTTP 200 with `responseData.translatedText` = the full 2-sentence Chinese translation. It
  accepted multi-sentence text.
- Live probe, 804-byte query returned HTTP 200 at transport level but
  `responseStatus: "403"`, `responseDetails` = `"QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS"`.
  So the 500 limit is real and enforced; the error text says CHARS, the spec says bytes.
- `langpair=en|zh-CN` works (live probes above).

Caveat / limit: MyMemory's Terms of Service explicitly forbid paragraph-level use:
> "use the APIs the way they are not meant to be used, like translating more than one paragraph at once
> (this completely defeats the purposes of a collaborative TM)"
(ToS `https://mymemory.translated.net/terms-and-conditions`, read via the same Archive snapshot.)
So single sentences are the intended unit; whole paragraphs are against the terms. There is also no
batch parameter — one `q` per request.

### 1.2 Response structure

Live probe shape (anonymous, `langpair=en|zh-CN`, no key):

```
{
  "responseData": { "translatedText": "...", "match": 0.85 },
  "quotaFinished": false,
  "mtLangSupported": null,
  "responseDetails": "",
  "responseStatus": 200,
  "responderId": null,
  "exception_code": null,
  "matches": [
    {
      "id": 0,
      "segment": "<the full source query>",
      "translation": "<the full translation>",
      "source": "en-GB", "target": "zh-CN",
      "quality": 70,
      "reference": "Machine Translation.",
      "usage-count": 2, "subject": false,
      "created-by": "MT!", "last-updated-by": "MT!",
      "create-date": "...", "last-update-date": "...",
      "match": 0.85, "penalty": null, "model": "neural"
    },
    {
      "id": "508588811",
      "segment": "The quick brown fox jumps over the lazy dog.",
      "translation": "敏捷的棕色狐狸跳过了懒狗。",
      "source": "en-GB", "target": "zh-CN",
      "quality": "74", "reference": null, "usage-count": 3, "subject": "All",
      "created-by": "MateCat", "match": 0.65, "penalty": 0
    }
  ]
}
```

Facts:

- Top level always has `responseData{translatedText, match}`, `quotaFinished`, `responseStatus`,
  `responseDetails`, and `matches[]` (live probes, `spec.php`).
- The MT result is `matches[0]` with `id: 0`, `created-by: "MT!"`, `reference: "Machine Translation."`,
  `model: "neural"` (live probe).
- **Source-segment alignment is only at translation-memory-entry granularity, not sub-sentence.**
  Each `matches[]` entry carries a paired `segment` (source) and `translation`, plus `quality`
  (0–100), `match` (0–1) and `penalty`. For the machine-translated result, `segment` is the *entire*
  `q` and `translation` the entire output; it is not split by sentence. Per-sentence pairs appear only
  when a human TM entry happens to exist at that granularity (e.g. the `508588811` entry above is one
  full sentence). This is exactly the "句级对齐" the prototype got for free from Google, but here it is
  conditional on TM coverage, not a property of the MT decoder.
- Value types are inconsistent: `quality` was a number in the MT entry and a string `"74"` in the TM
  entry; `responseStatus` is a number for success and a string `"403"` for the length error; `subject`
  was `false` in the MT entry and a string otherwise (live probe). Any parser must coerce.
- `mt` parameter: optional, default `1`; `mt=0` disables machine translation and returns "just human
  segments" (`spec.php`).

### 1.3 Rate limits and key

- Usage limits page (`https://mymemory.translated.net/doc/usagelimits.php`, Archive snapshot):
  - "MyMemory tracks it usage in words… it doesn't matter how many requests you submit… but the weight
    of each request."
  - "Free, anonymous usage is limited to **5000 chars/day**."
  - Provide a valid email (`de` parameter): "**50000 chars/day**."
  - CAT-tool whitelisting: **150000 chars/day**; explicitly not for personal / in-development projects
    that only use `get` and never contribute via `set`.
  - `Set` (contribution) "is never limited."
- **A key is not required.** `key` is Optional in the spec and only adds private-TM matches.
  Anonymous live probes succeeded with no key.
- Passing an invalid `key` fails the request: live probe with `key=deadbeef` returned
  `AUTHENTICATION FAILURE…` (and 403-class status). So omit `key` unless a private TM is needed.
- Response carries `quotaFinished` (boolean) to signal quota exhaustion (live probe).
- Other params (`spec.php`): `ip` (end-user IP; overridden by `X-Forwarded-For`), `de` (email),
  `user` (kept for backward compat, requires `key`), `onlyprivate`.

### 1.4 Privacy / data handling (ToS)

From `https://mymemory.translated.net/terms-and-conditions`:

- "We collect any segment submitted and store it on a long term basis, whether it's public or private."
- "We may collect information such as IP address, visiting time, duration, etc. for internal logging
  purposes."
- Public vs Private vs Personal data definitions; "Public Data" is data not explicitly marked private.
- Third-party sharing: "External Machine Translation providers is the most obvious example."
  "Translated can entitle its partners of a usage license over 'Public Data' or 'Private Data' in order
  to improve the quality of … services (eg. machine translation suggestions, glossaries, language
  models, spell checkers…)."
- "Translated is entitled full ownership on 'Public Data'."
- Use is "at the user's own sole risk"; service provided "as is".

Implication for this extension: sentence text sent to MyMemory is transmitted to a third party (and
its MT providers) and may be stored long-term and reused to improve language models, unless a private
TM + key is used. This is materially different from sending a single dictionary headword.

---

## 2. The extension's current provider contract (can it carry a sentence?)

Files: `src/dict/remote.ts`, `src/background/lookup.ts`, `src/core/messages.ts`,
`src/core/settings.ts`, `src/core/types.ts`, `src/manifest.json`, `src/dict/registry.ts`,
`src/options/options.ts`.

### 2.1 What exists today

- Provider settings (`src/core/settings.ts:14-26`): `OnlineSettings { enabled, provider:
  'mymemory' | 'custom', customUrl, customPath, timeoutMs, maxRequestsPerMinute }`.
  Defaults (`settings.ts:66-73`): `customPath: 'responseData.translatedText'`, `timeoutMs: 6000`,
  `maxRequestsPerMinute: 20`. `customPath` is described as "从 JSON 响应中取释义的路径，如
  `responseData.translatedText`" (`settings.ts:22-23`); `customUrl` "需含 `{word}` 占位符"
  (`settings.ts:20-21`). Sanitizer clamps timeout to 1–20 s and rpm to 1–120 (`settings.ts:112-124`).
- URL building (`src/dict/remote.ts:110-116`): MyMemory → `GET
  https://api.mymemory.translated.net/get?q=<encoded>&langpair=en|zh-CN`; custom →
  `customUrl.replace('{word}', encoded)`.
- Custom URL gate (`remote.ts:29-37`): must contain `{word}` **and** parse to `https:`. Options UI
  repeats this: `originOf()` requires `{word}` and `https:` and derives `${parsed.origin}/*`
  (`src/options/options.ts:247-256`), then requests it via
  `chrome.permissions.request({ origins: [origin] })` from a click handler
  (`options.ts:366-375`).
- Query gate (`remote.ts:118-121`): `const word = query.trim().toLowerCase();`
  `if (word === '' || !/^[a-z']+$/.test(word)) return null;` — **single lowercase ASCII word only**,
  apostrophes allowed, no spaces, digits, or punctuation.
- Response extraction (`remote.ts:160-165`, `getByPath` `remote.ts:40-58`): a dot path with array
  indices (`data.0.gloss`) into the JSON; MyMemory hardcodes `responseData.translatedText`; custom
  uses the configured `customPath`. It returns **one scalar**, not a list.
- Normalization (`remote.ts:63-81`, `sanitizeGloss`): must be a `string`; NFKC; strips `<tags>` and
  control chars; collapses whitespace; rejects if it equals the query; **truncates to
  `MAX_GLOSS_LENGTH = 24`** (`remote.ts:17`, `remote.ts:75`); requires at least one CJK char
  (`remote.ts:78`); rejects strings starting with error/no-query/invalid/too-many (`remote.ts:79`).
- Output type (`src/core/types.ts:58-72`): `LookupResult { lemma, surface, gloss, pos?, level?,
  source, at }`. There is **no translation field and no source-segment/alignment field**. `gloss` is
  required. `DictionaryProvider.lookup(query)` returns one `LookupResult | null` (`types.ts:74-93`).
- Messaging (`src/core/messages.ts:25-34`): request union has only `{ type: 'wordmark:lookup'; word:
  string }`; `LookupPayload` is `{ result: LookupResult | null }` (`messages.ts:46-48`). No
  sentence/paragraph request type.
- Background orchestration (`src/background/lookup.ts:60-90`): `lookup(word, online)`, cache key
  `normalizeToken(word.trim())` (`lookup.ts:61-62`); builds `RemoteDictionary` from settings
  (`lookup.ts:72-79`). Registry calls the remote provider once per surface after all locals miss
  (`src/dict/registry.ts:116-125`), with `stripClitics(normalizeToken(surface))`.
- Manifest (`src/manifest.json`): `minimum_chrome_version: "114"`; `permissions: ["storage"]`;
  `host_permissions: ["https://api.mymemory.translated.net/*"]`;
  `optional_host_permissions: ["https://*/*"]`. **https only; no http/local entries.**

### 2.2 Verdict: the contract cannot carry a sentence today

The current contract is strictly **one lowercase word in → one ≤24-char Chinese gloss out**, extracted
by a single scalar point-path. Failure points for sentence translation:

1. Placeholder name/semantics: `{word}` is the only placeholder; a sentence endpoint would need
   `{text}` (or a second placeholder), but `isUsableCustomUrl` rejects templates without `{word}`
   (`remote.ts:29-37`, `options.ts:247-256`).
2. Query validation rejects sentences (`remote.ts:119`).
3. Scheme gate is https-only, so a local `http://127.0.0.1:PORT/...` custom URL is rejected before any
   permission question (`remote.ts:34`, `options.ts:251`).
4. Response shape: `getByPath` returns one scalar; there is no way to express "this is the translation
   and these are the aligned source segments". MyMemory's per-segment pairs live in `matches[]`, which
   the current path mechanism cannot address as a whole.
5. `sanitizeGloss` truncates to 24 chars and demands Chinese — a full sentence translation would be
   mangled/truncated, and is not the data the caller wants anyway.
6. Types/messages have no place to put a sentence translation or alignment; the cache key is a
   normalized token (`lookup.ts:61-62`, `registry.ts`), so sentence-level caching needs a new key.

So a sentence-capable provider would require changes to: the placeholder name and validation; the
allowed scheme/host permissions; the response contract (a structured translation + aligned segments,
or a second path); a separate sanitizer/limit for sentence text; the result/message types; and the
cache key. These are listed as facts, not as a design.

---

## 3. Chrome MV3 permissions for local / private-network endpoints

### 3.1 Can an extension fetch loopback and LAN URLs?

**Yes, when it holds the necessary host permissions.** There is no blanket prohibition on
`http://127.0.0.1`, `http://localhost`, or `http://192.168.x.x`.

- Extension origins are not bound by the same-origin policy: "A script executing in an extension
  service worker or foreground tab can talk to remote servers outside of its origin, as long as the
  extension requests host permissions."
  (`https://developer.chrome.com/docs/extensions/develop/concepts/network-requests`)
- Same doc: access is granted by host **and** scheme, so plain HTTP must be declared separately from
  HTTPS: `"host_permissions": ["http://www.google.com/", "https://www.google.com/"]`. This is the
  documented mechanism by which a non-secure `http://` endpoint is reachable.
- Match-pattern syntax (`https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns`):
  `<scheme>://<host>:<port>/<path>`; scheme `http`, `https`, `*` (http+https), `file`; host is a
  hostname, `*.subdomain`, or `*`; port optional and **defaults to a wildcard** ("Match patterns match
  all ports unless an explicit port is specified"). Localhost/IP are called out explicitly:
  "Use `http://localhost/*`, or `http://127.0.0.1/*` (to match an IP address)." Examples:
  `http://127.0.0.1/*` matches any path on 127.0.0.1; `http://localhost/*` "Matches any localhost
  port."
- Limit: match patterns have **no CIDR/range syntax**. There is no documented way to write
  "all of 192.168.0.0/16"; the doc only demonstrates an IP *literal* (`127.0.0.1`). A LAN endpoint
  therefore needs its specific literal host pattern, or the broad wildcard `http://*/*`.

### 3.2 `host_permissions` vs `optional_host_permissions`

- `host_permissions` are requested at install time and "Changes may trigger a warning"; they grant
  access to the listed match patterns
  (`https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions`).
- `optional_host_permissions` are "Granted by the user at runtime, instead of at install time"
  (same doc). `chrome.permissions.request({ origins: [...] })` must be called from a user gesture
  (`https://developer.chrome.com/docs/extensions/reference/api/permissions`).
- To request hosts discovered at runtime, declare a broad optional entry, e.g.
  `"optional_host_permissions": ["https://*/*", "http://*/*"]`; the API doc states: "If you want to
  request hosts that you only discover at runtime, include `"https://*/*"` in your extension's
  optional_host_permissions field. This lets you specify any origin in `Permissions.origins` as long
  as it has a matching scheme." Ports: the `origins` list accepts origin patterns; match patterns match
  all ports by default (§3.1).
- The extension already uses this runtime-request flow, but its derived origin is **https-only**
  (`src/options/options.ts:247-256`) and the manifest optional entry is **https-only**
  (`src/manifest.json:42`). Reaching `http://127.0.0.1`, `http://localhost`, or a LAN IP would require
  adding the corresponding `http://…/*` patterns (specific literals, or `http://*/*`).

### 3.3 Does Private Network Access / Local Network Access apply to extension fetches?

- **Private Network Access (PNA)** was the earlier Chromium effort requiring CORS preflights from
  public websites to private/localhost endpoints. It applied to public websites, and it was
  **put on hold** and replaced by Local Network Access
  (`https://developer.chrome.com/blog/private-network-access-preflight`;
  `https://developer.chrome.com/blog/local-network-access`).
- **Local Network Access (LNA)** ships a permission prompt for *websites*: opt-in flag in Chrome 138,
  prompt launching in Chrome 142, applying to fetch/subresource/subframe requests (Chrome 147 adds
  WebSockets/WebTransport); the LNA permission was split into `local-network` and `loopback-network`
  in Chrome 145 (`https://developer.chrome.com/blog/local-network-access`; official
  "LNA Adoption Guide", linked from that post —
  `https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/`, "Last updated:
  May 18, 2026").
- **Extensions are explicitly out of scope.** The LNA Adoption Guide states:
  > "We do not currently have plans to apply LNA restrictions to extensions. Currently, extensions
  > that have the necessary host permissions are allowed to make local network requests."
  (LNA Adoption Guide, "What is the current scope of LNA restrictions in Chrome?")
- The LNA spec itself gates requests on a document/permission and notes that web Service Workers
  without an associated Document would fail the check
  (`https://wicg.github.io/local-network-access/`, "Define local network access behavior for Service
  Workers"). That is the site/worker model; the guide's explicit extension exemption governs
  extensions.
- Mixed content: LNA exempts private-IP-literal / `.local` / `targetAddressSpace:"local"` site fetches
  from mixed-content blocking (`https://developer.chrome.com/blog/local-network-access`). For
  extensions, the network-requests doc treats plain HTTP as reachable by declaring the `http` scheme
  in `host_permissions` (quoted in §3.1); no separate official statement was found that an extension
  service worker's `http://` LAN fetch is subject to mixed-content blocking. Treat the exact
  mixed-content behavior for a non-loopback LAN IP from an extension as **not fully documented** —
  a fact worth its own test.

Timeline summary (all from the two Chrome blog posts / adoption guide): PNA preflight experiment
(2021–2022) → rolled back/on hold → LNA opt-in flag Chrome 138 → LNA default prompt Chrome 142 →
permission split Chrome 145 → WebSocket/WebTransport Chrome 147. None of these milestones restrict
extensions.

---

## 4. OpenAI-compatible local endpoints as a sentence-translation source

Two implementations are in play in this repo: llama.cpp `llama-server` (laptop, CUDA) and MLX
`mlx_lm.server` (Mac).

### 4.1 llama.cpp `llama-server`

Source: `https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md` (fetched 2026-09-13).

- Endpoints: `POST /v1/chat/completions` and `POST /v1/completions` are OpenAI-compatible; the
  non-OpenAI `POST /completion` also exists.
- **Batching several inputs per request is possible on the non-OAI `/completion` endpoint.** Its
  `prompt` may be a single string, a token array, or an **array of prompts**: "Multiple prompts are
  also supported. In this case, the completion result will be an array." `n_cmpl`: "If input has
  multiple prompts, the output will have N prompts times n_cmpl entries."
- `/v1/chat/completions` takes one `messages` array (one conversation). There is no documented
  multi-conversation array in a single body; OpenAI-compatible `n` yields multiple completions of the
  same prompt, not multiple distinct sentences.
- Server-side concurrency: `-np, --parallel N` sets the number of slots; `-cb, --cont-batching`
  ("continuous batching a.k.a dynamic batching") is **enabled by default**. So batches are formed
  across concurrent requests as well as via the prompt array.
- Context: `-c, --ctx-size N` "size of the prompt context (default: 0, 0 = loaded from model)";
  logical batch `-b` default 2048, physical `-ub` default 512.
- Binding/reachability: `--host HOST` default **127.0.0.1** (loopback only), `--port PORT` default
  8080. The doc's Docker example uses `--host 0.0.0.0` to expose the service. Optional `--api-key`.
- Thinking control (relevant to latency): `--chat-template-kwargs` passes a JSON object, e.g.
  `'{"enable_thinking": false}'`.

Repo-measured facts (`prototype/mt-align/README.md`, `prototype/mt-align/openai.mjs`):

- Teacher run command used `-ngl 99 -c 4096 -fa on -t 8 -np 4 --chat-template-kwargs
  '{"enable_thinking":false}'` on a laptop RTX 4070 (README:168-173).
- With thinking disabled, a **single request carrying 6 sentences** returned `"1=1\n2=3\n3=1\n4=1\n
  5=1\n6=1"`, 12/12 answered, about **0.75 s/sentence** (README:141-144). So app-level batching of
  several sentences inside one chat message is measured working on the 9B teacher.
- The local 1.5B model, given the same multi-sentence batch, "直接把输入抄了回来" (copied the input
  back) (README:87-88, 144) — i.e. app-level batching was not reliable on the small local model.
- Latency, same model/quant (README:180-184):
  | | M4 (MLX) | laptop RTX 4070 (llama.cpp CUDA) |
  | --- | ---: | ---: |
  | single, first | 9166 ms | 308 ms (first) / 97 ms (prompt-cache hit) |
  | 1500 items | ~30 min | 239 s |
  | VRAM | — | 5932 / 8188 MiB |
- Across 1500 distillation observations: **239 s, 0 invalid indices, 488 words covered** (README:195-198).
- Client contract (`prototype/mt-align/openai.mjs:22,42,63`): default `baseUrl:
  'http://127.0.0.1:8000'`; `GET {base}/v1/models`; `POST {base}/v1/chat/completions` with
  `{model, messages, max_tokens, temperature, stream:false, ...extraBody}`; `AbortSignal.timeout`.
- Reachability note (README:176-178): the laptop's server on `127.0.0.1:8081` is reached from the Mac
  via `ssh -N -L 8081:127.0.0.1:8081 laptop` — i.e. loopback is not directly reachable across
  machines; a tunnel or a `--host 0.0.0.0` bind is required for LAN use.

### 4.2 MLX `mlx_lm.server`

Sources: `https://github.com/ml-explore/mlx-lm/blob/main/README.md` and
`https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py` (fetched 2026-09-13).

- Routes (`server.py` `do_POST` 1099-1107, `do_GET` 1638-1645): `POST /v1/completions`,
  `POST /v1/chat/completions` (plus `/chat/completions`), `GET /v1/models`, `GET /health`.
- Defaults (`server.py`): `--host` **127.0.0.1**; `--port` **8080**; `--max-tokens` default **512**;
  temperature default 0.0; `--prefill-step-size` default 2048; `--prompt-cache-size` default 10
  (max distinct KV caches); `--kv-bits` optional (quantized KV "Disables batching, so requests are
  served one at a time").
- **No context-size flag on the server.** Unlike llama.cpp's `-c`, `server.py` exposes no
  `--ctx-size`/`--max-kv-size`; context comes from the model. (The README documents `--max-kv-size`
  and `--prefill-step-size` for `mlx_lm.generate`/`chat`/`server`, but `server.py`'s argparse has no
  `--max-kv-size`.)
- **Batching**: server-side across concurrent requests via `BatchGenerator`
  (`server.py`: `--decode-concurrency` default 32, `--prompt-concurrency` default 8,
  `prefill_step_size` 2048). A single HTTP request carries **one prompt**: `CompletionRequest.prompt`
  is typed `str` (`server.py:200-208`), and `handle_text_completions` passes `self.body["prompt"]`
  straight through (`server.py:1619-1636`). So no multi-prompt array in one HTTP body.
- Python API alternative: the README points to a **batch generation example**
  (`mlx_lm/examples/batch_generate_response.py`) "to efficiently generate continuations for a batch of
  prompts", and documents rotating fixed-size KV cache / prompt caching / configurable prefill step
  size as long-context tools. So batch >1 prompt is available via the Python API or concurrent
  requests, not via one `/v1/completions` body.
- Repo use: `prototype/mt-align/README.md:125` runs the teacher at `http://127.0.0.1:8000`
  (`Qwen3.5-9B-MLX-4bit`); `prototype/mt-align/llm.py` instead loads MLX in-process (stdin JSONL →
  `mlx_lm.generate`, default model `Qwen2.5-1.5B-Instruct-4bit`, max_tokens 512) rather than through
  the server.
- Measured latency for local MLX generation (README:264-268, 289-294): 0.5B base 258 ms / +LoRA
  276 ms (150-sample eval); on 400 samples 110–134 ms. These are small-model single-request numbers,
  not translation of full paragraphs.

### 4.3 Trade-offs observed (no selection)

- Sentence batching: llama.cpp supports it two ways (non-OAI prompt array; continuous batching of
  concurrent requests). MLX supports it across concurrent requests / Python API but not as a
  multi-prompt HTTP body. App-level "N sentences in one chat message" is a prompt contract, measured
  reliable on 9B and unreliable on 1.5B locally.
- Context length: must be configured (`-c`, default = model); no server-side context flag on MLX.
  Longer context costs VRAM (laptop was at 5932/8188 MiB with `-c 4096`).
- Latency: first request includes model load (M4 9.2 s vs laptop 308 ms); prompt-cache hits ~3×
  faster (97 ms vs 308 ms). Whole-page translation cost scales with sentence count (1500 in 239 s on
  the 4070).
- Reachability: both default to `127.0.0.1`; LAN requires `--host 0.0.0.0` (llama.cpp documents this)
  or a tunnel. Chrome extension access requires the corresponding host permission (§3).
- Endpoint compatibility: both expose OpenAI-style `/v1/chat/completions`; llama.cpp additionally
  exposes a native multi-prompt `/completion`.

---

## 5. Other interface already measured in this repo (Google Translate)

`prototype/mt-align/mt.mjs` implements a Google endpoint (not MyMemory) that is directly relevant to
"translation + source-segment alignment":

- Endpoint `https://translate.googleapis.com/translate_a/single`, POST with
  `client=dict-chrome-ex`, `sl=en`, `tl=zh-CN`, `q=<text>`, `dt=t` (`mt.mjs:18,84-96`).
- "POST 且一次可翻整段，响应里每段都带回配对的源文片段 → 句级对齐是白送的"
  (README:41-46): the response is a list of `[target, source]` pairs (`mt.mjs:52-82,116`), so
  sentence-level source/target pairs are returned by the API itself.
- Limits (README:46-51): `client=gtx` was blocked; `client=dict-chrome-ex` workable; **after ~a dozen
  requests the source IP was hard-blocked**, and 40 s of backoff still returned 429. Chunking cap set
  to `MAX_CHARS_PER_REQUEST = 1800` (`mt.mjs:20`).
- The prototype therefore treats it as an optional side path and relies on disk caching + backoff
  (`mt.mjs:8-11,52-117`). No terms/privacy analysis of this endpoint is captured here.

---

## 6. Fact table (interface → capability / cost / limit / privacy)

| Interface | Sentence/paragraph input | Returns translation | Source-segment alignment | Batching | Rate/limits | Key | Privacy/data handling |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MyMemory `GET /get` | One sentence, ≤500 bytes/chars; multi-sentence accepted by API but ToS forbids "more than one paragraph at once" | `responseData.translatedText` | Only TM-entry pairs in `matches[].segment/translation` (conditional, not MT decoding alignment); MT entry `segment` = whole query | None (1 `q`/request) | Anonymous 5000 chars/day; valid `de` email 50000; whitelist 150000; `set` unlimited; `quotaFinished` flag | Not required; optional `key` for private TM; bad key → auth failure | Segments stored long-term; shared with external MT providers/partners; Translated owns Public Data (ToS) |
| Extension `custom` provider (today) | No — `{word}` placeholder only, query regex `^[a-z']+$` | One scalar via `customPath` | No | No (one request per surface) | Self-imposed `maxRequestsPerMinute` default 20 | N/A | Local endpoint or user-supplied URL; https-only today |
| Extension `mymemory` provider (today) | No — same word-only regex | `responseData.translatedText` truncated to 24 chars by `sanitizeGloss` | No | No | Same as settings (default 20 rpm) | No | Same as MyMemory above |
| Extension fetch to local/private host | N/A (transport) | N/A | N/A | N/A | Needs `http://…/*` host permission; no CIDR; LNA does not restrict extensions | N/A | Loopback/LAN stays on the user's network |
| llama.cpp `llama-server` | Yes (`/completion` prompt array; `/v1/chat/completions` one conversation) | Model output | No (model-level; alignment is an app concern) | Yes: multi-prompt array + continuous batching default; `-np` slots | Local hardware-bound; recommended `-c`/`-np` settings | Optional `--api-key` | Stays local (unless bound to LAN) |
| MLX `mlx_lm.server` | Yes via concurrent requests / Python batch API; one HTTP prompt per request | Model output | No | Yes across concurrent requests (`BatchGenerator`, decode 32 / prompt 8); README batch API | Local hardware-bound; `--max-tokens` default 512; no server context flag | None documented | Stays local (unless bound to LAN) |
| Google `translate_a/single` (`client=dict-chrome-ex`) | Yes, POST whole paragraph | Yes | **Yes — response is `[target, source]` pairs** | Yes (whole paragraph per POST; chunking in code) | Hard IP block after ~a dozen requests; 429 | No | Not analyzed in repo |

---

## Sources

Primary external:

- MyMemory API spec: <https://mymemory.translated.net/doc/spec.php> (read via Internet Archive
  capture `20241218125605`, 2024-12-18; live URL returned 403 from this machine).
- MyMemory usage limits: <https://mymemory.translated.net/doc/usagelimits.php> (Archive snapshot).
- MyMemory terms: <https://mymemory.translated.net/terms-and-conditions> (Archive snapshot).
- MyMemory live API probes: `https://api.mymemory.translated.net/get` (2026-09-13).
- Chrome cross-origin network requests:
  <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- Chrome match patterns:
  <https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns>
- Chrome declare permissions:
  <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chrome `chrome.permissions` API:
  <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- Private Network Access (on hold): <https://developer.chrome.com/blog/private-network-access-preflight>
- Local Network Access blog / timeline: <https://developer.chrome.com/blog/local-network-access>
- LNA Adoption Guide (official Google Doc linked from the blog, last updated 2026-05-18):
  <https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/>
- LNA specification: <https://wicg.github.io/local-network-access/>
- llama.cpp server README:
  <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md>
- mlx-lm README: <https://github.com/ml-explore/mlx-lm/blob/main/README.md>
- mlx-lm server source: <https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py>

Repo files:

- `src/dict/remote.ts`, `src/dict/registry.ts`, `src/background/lookup.ts`,
  `src/core/messages.ts`, `src/core/settings.ts`, `src/core/types.ts`, `src/manifest.json`,
  `src/options/options.ts`
- `prototype/mt-align/README.md`, `prototype/mt-align/openai.mjs`, `prototype/mt-align/mt.mjs`,
  `prototype/mt-align/batch.mjs`, `prototype/mt-align/llm.py`
