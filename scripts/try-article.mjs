/**
 * 真实文章测试台。
 *
 * 拿一篇线上文章（或本地 HTML）喂给**构建产物** dist/content.js，
 * 报告真实场景下关心的几件事：
 *   - 覆盖率：这篇文章的词里有多少能被离线词表认出来
 *   - 产出：实际标注了多少处、哪些词
 *   - 完整性：把释义摘掉之后，正文是否逐字回到原文
 *   - 漏词清单：按出现频次排序的未收录词（用来决定下一步补哪些词）
 *   - 耗时
 *
 * 用法：
 *   node scripts/try-article.mjs <url|本地 html 路径> [--json] [--top=40]
 *                                [--level=basic|cet4|cet6|ielts|gre] [--repeat=first|all]
 *                                [--dump-missing[=路径]]
 *
 * 依赖 dist/content.js，先跑 npm run build:prod。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(ROOT, '.tmp-articles');

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const asJson = args.includes('--json');
const topFlag = args.find((arg) => arg.startsWith('--top='));
const TOP = topFlag ? Number(topFlag.split('=')[1]) : 40;
const dumpFlag = args.find((arg) => arg.startsWith('--dump-missing'));
const DUMP = dumpFlag ? (dumpFlag.includes('=') ? dumpFlag.split('=')[1] : '') : null;
const levelFlag = args.find((arg) => arg.startsWith('--level='));
const LEVEL = levelFlag ? levelFlag.split('=')[1] : null;
const repeatFlag = args.find((arg) => arg.startsWith('--repeat='));
const REPEAT = repeatFlag ? repeatFlag.split('=')[1] : null;

if (!target) {
  console.error('用法：node scripts/try-article.mjs <url|本地 html 路径> [--json] [--top=40]');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadHtml(source) {
  if (existsSync(source)) return { html: await readFile(source, 'utf8'), url: 'https://example.com/local' };
  await mkdir(CACHE_DIR, { recursive: true });
  const cacheName = source.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120);
  const cacheFile = path.join(CACHE_DIR, `${cacheName}.html`);
  if (existsSync(cacheFile)) return { html: await readFile(cacheFile, 'utf8'), url: source };

  const response = await fetch(source, {
    headers: {
      // 有些站点会对默认 UA 返回空壳页面
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const html = await response.text();
  await writeFile(cacheFile, html, 'utf8');
  return { html, url: source };
}

/** 正文里所有英文词（含 the/a 这类），用来算「每千词标注多少处」的阅读密度。 */
function runningWordCount(text) {
  return (text.match(/[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g) ?? []).length;
}

/** 与 src/core/tokenizer.ts 保持一致的候选词判定（测试台里独立实现，避免只测到自己）。 */
const MIN_WORD_LENGTH = 3;
function candidateWords(text) {
  const words = text.match(/[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g) ?? [];
  const out = [];
  for (const raw of words) {
    const letters = raw.replace(/['\u2019]/g, '');
    if (letters.length < MIN_WORD_LENGTH) continue;
    if (letters.length >= 2 && letters === letters.toUpperCase()) continue;
    if (/[a-z][A-Z]/.test(raw)) continue;
    out.push(raw.replace(/\u2019/g, "'").toLowerCase());
  }
  return out;
}

/**
 * 高频功能词与最基础词汇。
 *
 * 只用于**统计**：候选词里绝大多数是 the / you / and 这类词，
 * 它们本来就不该被标注（词典里没有它们正是设计意图），
 * 把它们算进分母会让覆盖率看起来毫无意义。剔掉之后剩下的
 * 「未收录内容词」才是真正该看的清单。
 */
const FUNCTION_WORDS = new Set(
  `the a an and or but if so as of to in on at by for with from into over under about after before between during
   without within across behind beyond up down out off again further then once here there when where why how all any
   both each few more most other some such no nor not only own same than too very can will just should now
   i me my we our you your he him his she her it its they them their this that these those who whom which what whose
   is am are was were be been being have has had having do does did doing would could shall may might must
   one two three four five six seven eight nine ten first second third next last many much every another
   get got make made take took come came go went see saw know knew think thought say said tell told want wanted
   need needed use used find found give gave work works worked working way ways thing things people person time
   year years day days life world lot part lot new old good great big small long short high low right left
   also however because while although though since until unless whether either neither nor yet still even
   per via etc vs vs. eg ie mr mrs ms dr st com org net www http https html amp nbsp
   don't didn't doesn't isn't aren't wasn't weren't can't couldn't won't wouldn't shouldn't it's that's
   i'm i've you're you've we're they're he's she's there's what's let's`
    .split(/\s+/)
    .filter((word) => word !== ''),
);

/** 正文区域启发式：覆盖率只统计正文，避免把导航 / 页脚算进来。 */
function mainRegion(document) {
  const selectors = [
    '#mw-content-text', // Wikipedia
    'article',
    '[role="main"]',
    'main',
    '.post-content, .entry-content, .article-body',
  ];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element && (element.textContent ?? '').length > 800) return { element, selector };
  }
  return { element: document.body, selector: 'body（未识别出正文区域）' };
}

function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** chrome.storage.get 的语义：传数组取指定键，传空取全部。 */
function pick(store, keys) {
  if (keys === undefined || keys === null) return { ...store };
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const key of list) if (key in store) out[key] = store[key];
  return out;
}

async function main() {
  const contentScript = await readFile(path.join(DIST, 'content.js'), 'utf8');
  const { html, url } = await loadHtml(target);

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { document } = dom.window;

  // 想覆盖设置就注入一个最小的 chrome.storage：content script 读到的是
  // 这些值，其余字段由 sanitizeSettings 补默认值（所以只需要写要改的项）。
  if (LEVEL !== null || REPEAT !== null) {
    const overrides = {};
    if (LEVEL !== null) overrides.annotateFrom = LEVEL;
    if (REPEAT !== null) overrides.repeatMode = REPEAT;
    const store = { 'wordmark:settings': overrides, 'wordmark:knownWords': [] };
    dom.window.chrome = {
      storage: {
        sync: {
          get: async (keys) => pick(store, keys),
          set: async () => {},
        },
        local: {
          get: async (keys) => pick(store, keys),
          set: async (items) => Object.assign(store, items),
          remove: async () => {},
        },
        onChanged: { addListener: () => {}, removeListener: () => {} },
      },
    };
  }

  // 页面自身的 <script> 不执行（真实浏览器里会执行，这里只测标注本身）
  const pageTitle = document.title;
  const bodyTextBefore = document.body.textContent ?? '';
  const { element: region, selector: regionSelector } = mainRegion(document);
  const regionTextBefore = region.textContent ?? '';

  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(String(event.message)));

  const started = Date.now();
  dom.window.eval(contentScript);

  // 等到标注数量稳定下来（去抖 + 分批让出主线程）
  let last = -1;
  let stableFor = 0;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const current = document.querySelectorAll('[data-wordmark-lemma]').length;
    if (current === last) {
      stableFor += 1;
      // 有产出后稳定 400ms 即可收工；一点产出都没有时给 2s 兜底
      if (stableFor >= 8 && (current > 0 || Date.now() - started > 2000)) break;
    } else {
      stableFor = 0;
      last = current;
    }
    await sleep(50);
  }
  const elapsedMs = Date.now() - started;

  const marks = [...document.querySelectorAll('[data-wordmark-lemma]')];
  const glossedLemmas = new Map();
  for (const mark of marks) {
    const lemma = mark.getAttribute('data-wordmark-lemma');
    glossedLemmas.set(lemma, (glossedLemmas.get(lemma) ?? 0) + 1);
  }

  // 正文覆盖率：候选词里有多少被标注（按词元去重）
  const regionCandidates = new Set(candidateWords(regionTextBefore));
  const glossedInRegion = new Set(
    [...region.querySelectorAll('[data-wordmark-lemma]')].map((mark) =>
      mark.getAttribute('data-wordmark-lemma'),
    ),
  );
  // 频次排序的漏词清单：先看最值得补的词
  const frequency = new Map();
  const contentFrequency = new Map();
  for (const word of candidateWords(regionTextBefore)) {
    if (glossedInRegion.has(word)) continue;
    frequency.set(word, (frequency.get(word) ?? 0) + 1);
    if (!FUNCTION_WORDS.has(word)) contentFrequency.set(word, (contentFrequency.get(word) ?? 0) + 1);
  }
  const topMissing = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP);
  const topMissingContent = [...contentFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP);

  // 内容词覆盖率：分母剔掉功能词，才是「生词有没有被认出来」的真实观感
  const contentCandidates = new Set([...regionCandidates].filter((word) => !FUNCTION_WORDS.has(word)));
  const contentHit = [...contentCandidates].filter((word) => glossedInRegion.has(word)).length;
  // 完整性：先摘掉所有释义，再把标注外壳解开，正文必须逐字回到原文，
  // 并且不能有任何 [data-wordmark] 残留。
  for (const def of document.querySelectorAll('.wordmark-def')) def.remove();
  const wrappers = [...document.querySelectorAll('[data-wordmark-lemma]')];
  for (const wrapper of wrappers) wrapper.replaceWith(...wrapper.childNodes);
  for (const parent of new Set(wrappers.map((wrapper) => wrapper.parentNode))) {
    parent?.normalize?.();
  }
  const textAfter = document.body.textContent ?? '';
  const integrityOk =
    collapse(textAfter) === collapse(bodyTextBefore) &&
    document.querySelectorAll('[data-wordmark]').length === 0;

  const sample = [...glossedLemmas.entries()]
    .slice(0, 24)
    .map(([lemma, count]) => {
      const mark = document.querySelector(`[data-wordmark-lemma="${CSS_escape(lemma)}"]`);
      const gloss = mark?.querySelector('.wordmark-def')?.textContent ?? '';
      return { lemma, gloss, count };
    });

  const report = {
    url,
    title: pageTitle,
    regionSelector,
    level: LEVEL ?? 'cet4（默认）',
    repeatMode: REPEAT ?? 'first（默认）',
    bodyChars: bodyTextBefore.length,
    regionChars: regionTextBefore.length,
    runningWords: runningWordCount(regionTextBefore),
    bodyTokens: candidateWords(bodyTextBefore).length,
    regionUniqueCandidates: regionCandidates.size,
    regionContentCandidates: contentCandidates.size,
    contentCoverage: contentCandidates.size === 0 ? 0 : contentHit / contentCandidates.size,
    glossedTotal: marks.length,
    glossedUnique: glossedLemmas.size,
    glossedInRegionUnique: glossedInRegion.size,
    coverageInRegion:
      regionCandidates.size === 0 ? 0 : glossedInRegion.size / regionCandidates.size,
    topMissing,
    topMissingContent,
    integrityOk,
    elapsedMs,
    errors,
  };

  if (asJson) {
    console.log(JSON.stringify({ ...report, sample }, null, 2));
  } else {
    printReport(report, sample);
  }

  // 漏词清单落盘：这是「按真实阅读材料补词表」的采集入口
  if (DUMP !== null) {
    const slug = target.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-60);
    const outFile = DUMP === '' ? path.join(CACHE_DIR, `missing-${slug}.json`) : DUMP;
    const payload = {
      url,
      title: pageTitle,
      regionChars: report.regionChars,
      contentCoverage: report.contentCoverage,
      missing: [...contentFrequency.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    };
    await writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    console.log(`漏词清单已写入 ${path.relative(ROOT, outFile)}（${payload.missing.length} 个未收录内容词）`);
  }

  dom.window.close();
  process.exit(errors.length === 0 && integrityOk ? 0 : 2);
}

function CSS_escape(value) {
  return value.replace(/["\\]/g, '\\$&');
}

function printReport(report, sample) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(`\n文章：${report.title || '(无标题)'}`);
  console.log(`地址：${report.url}`);
  console.log(`正文区域：${report.regionSelector}`);
  console.log('');
  console.log(`  正文长度          ${report.regionChars} 字符（整页 ${report.bodyChars}）`);
  console.log(`  运行词数          ${report.runningWords}`);
  console.log(`  候选词（去重）    ${report.regionUniqueCandidates}（其中内容词 ${report.regionContentCandidates}）`);
  console.log(`  离线词表命中      ${report.glossedInRegionUnique}  → 内容词覆盖率 ${pct(report.contentCoverage)}`);
  console.log(`  插入释义          ${report.glossedTotal} 处 / ${report.glossedUnique} 个词`);
  console.log(
    `  阅读密度          每千词 ${((report.glossedTotal / Math.max(1, report.runningWords)) * 1000).toFixed(1)} 处` +
      `（≈ 每 ${Math.round(report.runningWords / Math.max(1, report.glossedTotal))} 词一处）`,
  );
  console.log(`  生词线            ${report.level}${report.repeatMode.startsWith('first') ? '' : ` / 重复策略 ${report.repeatMode}`}`);
  console.log(`  正文完整性        ${report.integrityOk ? '✓ 摘掉释义后逐字还原原文' : '✗ 与原文不一致！'}`);
  console.log(`  耗时              ${report.elapsedMs} ms`);
  if (report.errors.length > 0) console.log(`  未捕获异常        ${report.errors.join(' | ')}`);

  console.log('\n  标注样例：');
  for (const item of sample) {
    console.log(`    ${item.lemma.padEnd(16)} ${item.gloss.padEnd(14)} ×${item.count}`);
  }

  console.log(`\n  未收录的内容词 Top ${report.topMissingContent.length}（已剔掉功能词）：`);
  console.log(`    ${report.topMissingContent.map(([w, c]) => `${w}(${c})`).join('  ')}`);

  console.log(`\n  未收录词 Top ${Math.min(report.topMissing.length, 12)}（含功能词，仅供参考）：`);
  console.log(`    ${report.topMissing.slice(0, 12).map(([w, c]) => `${w}(${c})`).join('  ')}`);
  console.log('');
}

await main();
