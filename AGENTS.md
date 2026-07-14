# AGENTS.md - wordmark

## Architecture

Two-phase CET word annotation:
1. **First pass**: `replaceMatches()` via Aho-Corasick + DOM walker. Creates `<mark>` elements with just the word (no definition — marks are empty placeholders).
2. **Batch pass**: Scan DOM text directly (separate Aho-Corasick), send all found CET words + ~950 chars of page text to service worker. Service worker does ONE Bing call → splits English/Chinese into sentences → aligns by index → for each CET word, finds its Chinese sentence → extracts the best matching Chinese word from dict's pre-extracted `cn[]` list.

## Dict Build (`scripts/fetch-dict.mjs`)
- Fetches definitions for all 5634 CET-4/CET-6 words from Youdao jsonapi
- Runs sequentially with 150ms delay (parallel requests fail). Takes ~15 min.
- Pre-extracts core Chinese words from each definition via `extractCoreWords()` (same logic as original `extractAllCoreWords` but run at build time)
- Output: `src/common/dict.json` (1.2MB), with structure `{word: {def: string, cn: string[]}}`
- 4 words have empty defs (proper nouns: italian, portuguese, spanish, win)

## Key Design Decisions

### Role of dictionary
- **Dictionary** (`src/common/dict.json`) is used **only to select which words to annotate** (CET-4/CET-6 word list)
- **Bing translation** provides the content shown in annotation brackets: the Chinese sentence containing the translated word
- `translate(word)` (context menu) still shows dictionary definition
- `batchTranslate(words, pageText)` returns the Bing-translated Chinese sentence for each CET word

### Bundled dictionary (`src/common/dict.ts`)
- Import `dict.json` directly, exported as `BUNDLED_DICT` + `lookup(word)` function
- Lives ONLY in service worker bundle (2.2MB). Content script stays lean (83KB).
- Fallback: if Bing fails, `batchTranslate` uses `lookup(word)?.def` for each word.

### Bing translate (`src/background/bing.ts`)
- Fetch token (`IG`, `IID`, `key`, `token`) from `bing.com/translator` HTML, POST to regional `ttranslatev3`
- Token refresh on expiry / HTTP 429
- Response may be JSON or HTML (gender debiasing). Read as text first, parse based on `Content-Type`.
- Real max payload: **~1000 chars** (even in China region). Truncate to 950 in `batchTranslate`
- Request body includes `tryFetchingGenderDebiasedTranslations: true`; key as number (not string)

### Batch translate (`src/background/translator.ts`)
- `batchTranslate(words, pageText)`: Bing (~5s) → split English and Chinese into sentences → align by index → for each word: find its English sentence, return the corresponding Chinese sentence → `pickBestMatch(entry.cn, zhSentence)` extracts the best Chinese word
- If no `cn[]` word matches the Chinese sentence, falls back to `entry.cn[0]` (first core Chinese word)
- Bing fallback (if Bing fails): returns dictionary `def` for each word
- `translate(word)` (individual context-menu lookup): just `lookup(word)?.def ?? ""`
- No more Youdao API calls at runtime. No concurrency issues. No rate limiting.

### Content script (`src/content/index.ts`)
- All CET word definitions come from service worker via `batch-translate` message
- `buildVocabInfoMap()` sets `definition: ""` for all CET words — marks are created empty
- `fetchBatchDefinitions()` sends found words + page text → receives Bing sentence translations → updates all marks
- `updateAnnotation()` now always overwrites (no `if (!includes("("))` guard) — OK because marks start empty

### Aho-Corasick (`src/content/matcher.ts`)
- Built from `Map<string, string[]>` of base word → inflected forms
- `search(text, wordBounds)` returns `MatchResult[]` (word, index, endIndex)
- Word bounds filter: match accepted only if `index === bound.start && endIndex === bound.end`

### Inflector (`src/content/inflector.ts`)
- `generateInflections(word)` returns array with base, -s, -es, -ies, -ed, -ied, -d, -ing, doubled-consonant + -ing/-ed

## Common Pitfalls

1. **Async annotation race**: `processChunk` runs via `requestIdleCallback`. Never collect data from DOM marks immediately after calling `replaceMatches` — scan `document.body.textContent` directly instead.
2. **Youdao parallelism**: Always sequential (build-time only now). Parallel requests fail.
3. **Bounds format**: `WordBound[]` = `[{start, end}]`, not `number[]`.
4. **CET vocab contents**: Many common words are in CET lists (apple, banana, rainbow, seven, etc.).
5. **Bing text limit**: Real limit is ~1000 chars, not the documented 5000 (China) or 1000 (elsewhere). Truncate to 950.
6. **Bing response format**: May return JSON or HTML. Read as text, check `Content-Type`.
7. **Service worker logs**: Captured via `worker.on('console')`. Page/content script logs via `page.on('console')`.
8. **Build**: All background modules bundled into `service-worker.js` by esbuild. Dict (~2.2MB) only in SW.
9. **`getWordBounds`**: Uses `Intl.Segmenter` — returns `WordBound[]` objects. Must NOT return flat `number[]`.
10. **Sentence alignment**: Bing may merge/split sentences. 1:1 index alignment works for most texts. If counts differ, trailing unmatched sentences are attached to the last aligned sentence.

## Test Flow

1. Fresh persistent context (`launchPersistentContext` with new temp dir)
2. Init popup page, set settings (enabled=true, cet4/6 enabled, importSampleDone)
3. Load `chrome-extension://EXT_ID/test-page.html`
4. Wait ~15s for batch to complete (Bing ~5s + sentence mapping instant)
5. Query marks via `page.evaluate`
