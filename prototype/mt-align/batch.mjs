/**
 * 原型：批量 vs 逐句——延迟里有多少是「每次调用的固定开销」？
 *
 * 【原型代码，不是生产实现】
 *
 * 动机：实测句均约 0.6-1 秒。一篇 100 句的文章就是 1-2 分钟，能不能接受完全取决于
 * 这些时间花在「生成」还是「开销」上。把多句塞进一次调用，如果句均骤降，
 * 说明大头是开销，生产实现就必须批量。
 *
 * 用法：npm run proto:align:batch
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm, SYSTEM, parseJsonObject, score, splitEndToEnd } from './align.mjs';
import { candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const MODEL = flag('model', 'mlx-community/Qwen2.5-1.5B-Instruct-4bit');
const SENTENCES = Number(flag('sentences', 8));
const WORDS = Number(flag('words', 3));

async function loadSentences() {
  const dir = path.join(ROOT, '.tmp-articles');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.html'));
  const file = files.find((name) => name.includes('paulgraham')) ?? files[0];
  const html = await readFile(path.join(dir, file), 'utf8');
  return splitSentences(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, ' '),
  );
}

const FUNCTION_WORDS = new Set(
  'about also after again against all and any are because been before being both but can could did does doing down during each few for from further had has have having her here hers him his how into its just like made make many more most much must not now off only other our out over own same she should some such than that the their them then there these they this those through too under until very was were what when where which while who whom why will with would you your able back come came even ever every first found get give given goes going gone good great keep kind know known last less life little long look making may mean means might need never new next none nothing often once one ones other part past people place point put right said same say says see seem seen shall side since still take taken thing things think time times today upon used using want way ways well went whole without work works year years yet'.split(
    /\s+/,
  ),
);

function pickWords(sentence, dictionary, limit) {
  const candidates = candidateWords(sentence).filter((word) => !FUNCTION_WORDS.has(word));
  const missing = candidates.filter((w) => !dictionary.has(w)).sort((a, b) => b.length - a.length);
  const known = candidates.filter((w) => dictionary.has(w)).sort((a, b) => b.length - a.length);
  return [...missing, ...known].slice(0, limit);
}

/**
 * 一次调用处理多个句子。
 *
 * 注意：第一版让模型输出嵌套 JSON 数组，1.5B 直接吐不出来（8 条 results 全丢）。
 * 换成「一行一句」的扁平格式后小模型才驾驭得住——这是小模型的现实约束：
 * 输出结构越浅越好，别指望它稳定产出嵌套 JSON。
 */
function buildBatchPrompt(items) {
  return [
    `请处理下面 ${items.length} 个英文句子。每个句子输出一行，格式严格如下：`,
    '编号. 整句中文翻译 || 单词1=释义1; 单词2=释义2',
    '',
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.sentence}`,
      `   要释义的词：${item.words.join(', ')}`,
    ]),
    '',
    '规则：',
    '1. 每行必须以「编号. 」开头，编号与上面一致，一共输出 ' + items.length + ' 行。',
    '2. 用 || 分隔译文与释义；释义之间用 ; 分隔；每条释义写成 单词=释义。',
    '3. 释义用 2 到 6 个汉字，只给该词在该句中的意思。',
    '4. 不要输出 JSON、不要解释、不要多余空行。',
    '',
    '输出：',
  ].join('\n');
}

/** 解析「一行一句」的输出。 */
function parseBatchLines(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    const match = line.match(/^\s*(\d+)\s*[.、)]\s*(.+?)\s*\|\|\s*(.+)$/);
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const glosses = new Map();
    for (const pair of match[3].split(/[;；]/)) {
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const word = pair.slice(0, at).replace(/[^A-Za-z'’]/g, '').trim().toLowerCase();
      const gloss = pair.slice(at + 1).replace(/[^\u4e00-\u9fff]/g, '').trim();
      if (word !== '' && gloss !== '') glosses.set(word, { gloss });
    }
    out[index] = { translation: match[2].trim(), glosses };
  }
  return out;
}

function buildOnePrompt(item) {
  return [
    '英文句子：',
    item.sentence,
    '',
    `请先把这句话翻成中文，再给下面每个单词写出它在这句话里的中文释义：${item.words.join(', ')}`,
    '',
    '规则：',
    '1. 释义用 2 到 6 个汉字，只给该词在本句中的意思。',
    '2. 每个释义都必须是你在第一项里给出的那句译文的一部分（原样出现）。',
    '3. 只输出 JSON，形如：{"translation": "整句译文", "glosses": {"word": "释义"}}',
    '',
    'JSON：',
  ].join('\n');
}

function summarise(label, results, elapsedMs, items) {
  let candidates = 0;
  let answered = 0;
  let strict = 0;
  let loose = 0;
  for (const [index, item] of items.entries()) {
    const bucket = results[index] ?? { translation: '', glosses: new Map() };
    const s = score({ words: item.words, translation: bucket.translation, results: bucket.glosses });
    candidates += s.candidates;
    answered += s.answered;
    strict += s.strict;
    loose += s.loose;
  }
  return {
    label,
    candidates,
    coverage: candidates === 0 ? 0 : answered / candidates,
    strict: answered === 0 ? 0 : strict / answered,
    loose: answered === 0 ? 0 : loose / answered,
    totalMs: elapsedMs,
    perSentenceMs: Math.round(elapsedMs / items.length),
  };
}

async function main() {
  const dictionary = new Map(
    JSON.parse(await readFile(path.join(ROOT, 'src', 'data', 'dict.zh.json'), 'utf8')).map((e) => [
      e.word,
      e,
    ]),
  );
  const all = await loadSentences();
  const items = [];
  for (const sentence of all) {
    if (items.length >= SENTENCES) break;
    const words = pickWords(sentence, dictionary, WORDS);
    if (words.length >= 2) items.push({ sentence, words });
  }
  console.log(`模型：${MODEL}`);
  console.log(`样本：${items.length} 句，每句 ${WORDS} 个词\n`);

  const llm = new LocalLlm({ model: MODEL }).start();
  try {
    // 预热：模型加载不该算进任何一方的账
    const warmStarted = Date.now();
    await llm.ask(SYSTEM, buildOnePrompt(items[0]));
    console.log(`预热（含模型加载）：${Date.now() - warmStarted}ms\n`);

    // 逐句
    const oneResults = [];
    const oneStarted = Date.now();
    for (const item of items) {
      const parsed = parseJsonObject(await llm.ask(SYSTEM, buildOnePrompt(item)));
      oneResults.push(splitEndToEnd(parsed));
    }
    const oneMs = Date.now() - oneStarted;

    // 批量：全部塞进一次调用
    const batchStarted = Date.now();
    const batchRaw = await llm.ask(SYSTEM, buildBatchPrompt(items));
    const batchMs = Date.now() - batchStarted;
    const batchResults = parseBatchLines(batchRaw);
    const missing = items.length - batchResults.length;

    const rows = [
      summarise('逐句（N 次调用）', oneResults, oneMs, items),
      summarise('批量（1 次调用）', batchResults, batchMs, items),
    ];
    console.log('方式                  覆盖率   严格对齐   宽松对齐   总耗时      句均');
    for (const row of rows) {
      console.log(
        `${row.label.padEnd(20)} ${(row.coverage * 100).toFixed(0).padStart(3)}%    ${(row.strict * 100).toFixed(0).padStart(3)}%      ${(row.loose * 100).toFixed(0).padStart(3)}%      ${String(row.totalMs).padStart(6)}ms  ${String(row.perSentenceMs).padStart(5)}ms`,
      );
    }
    if (missing > 0) console.log(`\n批量返回的 results 少了 ${missing} 条（模型没按数量输出）`);
    const speedup = rows[1].perSentenceMs === 0 ? 0 : rows[0].perSentenceMs / rows[1].perSentenceMs;
    console.log(`\n批量把句均延迟压到 1/${speedup.toFixed(1)}`);
  } finally {
    llm.stop();
  }
}

await main();
