/**
 * 原型入口：本地小模型能不能把「整句翻译」对齐回单个词？
 *
 * 【原型代码，不是生产实现】
 *
 * 它回答三个问题：
 *   1. 一次通过（译文 + 逐词释义一起生成）够不够用？
 *   2. 两段式（先出译文，再让模型把释义对齐到译文）是否更准？
 *   3. 与现有词表比，模型给的是「对的意思」还是「编的」？
 *
 * 度量方式：
 *   - 覆盖率：候选词里拿到非空释义的比例
 *   - 自洽率：释义是否为该次译文里原样出现的片段 —— 「释义确实对应译文那部分」的客观代理，
 *     不需要人眼判断
 *   - 词表对照：词表已收录的词把两边释义并排打出来，对错一眼可见
 *
 * 用法：
 *   npm run proto:align                              # 本地模型，4 句
 *   npm run proto:align -- --sentences=8 --words=4
 *   npm run proto:align -- --text="Some sentence."
 *   npm run proto:align -- --mt=google               # 另试谷歌机翻（会被限流，见输出）
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalLlm,
  SYSTEM,
  buildAlignedPrompt,
  buildEndToEndPrompt,
  parseJsonObject,
  score,
  splitEndToEnd,
} from './align.mjs';
import { MachineTranslator, candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE_DIR = path.join(ROOT, '.tmp-articles');
const CACHE_FILE = path.join(ROOT, '.tmp-probe', 'mt-cache.json');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const SENTENCE_COUNT = Number(flag('sentences', 4));
const WORDS_PER_SENTENCE = Number(flag('words', 4));
const TEXT = flag('text', null);
const MODEL = flag('model', 'mlx-community/Qwen2.5-1.5B-Instruct-4bit');
const MT = flag('mt', 'local');

async function loadSentences() {
  if (TEXT) return splitSentences(TEXT);
  const files = (await readdir(CACHE_DIR)).filter((file) => file.endsWith('.html'));
  const file = files.find((name) => name.includes('paulgraham')) ?? files[0];
  const html = await readFile(path.join(CACHE_DIR, file), 'utf8');
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ');
  return splitSentences(text);
}

/** 高频虚词与最基础词：本来就不该进注解，剔掉才测得出真实场景。 */
const FUNCTION_WORDS = new Set(
  `about also after again against all and any are because been before being both but can could did does doing down
   during each few for from further had has have having her here hers him his how into its just like made make many
   more most much must not now off only other our out over own same she should some such than that the their them
   then there these they this those through too under until very was were what when where which while who whom why
   will with would you your yours able back come came even ever every first found get give given goes going gone
   good great keep kind know known last less life little long look made making may mean means might much need never
   new next none nothing often once one ones other part past people place point put right said same say says see
   seem seen shall side since still take taken than thing things think time times today under upon used using want
   way ways well went what where whole without work works year years yet`
    .split(/\s+/)
    .filter(Boolean),
);

/** 挑最值得问的候选词：先照顾词表没覆盖的，再按长度。 */
function pickWords(sentence, dictionary, limit) {
  const candidates = candidateWords(sentence).filter((word) => !FUNCTION_WORDS.has(word));
  const missing = candidates.filter((word) => !dictionary.has(word)).sort((a, b) => b.length - a.length);
  const known = candidates.filter((word) => dictionary.has(word)).sort((a, b) => b.length - a.length);
  return [...missing, ...known].slice(0, limit);
}

function bar(value) {
  const filled = Math.round(value * 16);
  return `${'█'.repeat(filled)}${'·'.repeat(16 - filled)}`;
}

function cell(text, width) {
  const visible = [...text];
  if (visible.length > width) return `${visible.slice(0, width - 1).join('')}…`;
  return text + ' '.repeat(Math.max(0, width - visible.length));
}

async function main() {
  const dictionary = new Map(
    JSON.parse(await readFile(path.join(ROOT, 'src', 'data', 'dict.zh.json'), 'utf8')).map((entry) => [
      entry.word,
      entry,
    ]),
  );

  const all = await loadSentences();
  const sentences = all.slice(0, SENTENCE_COUNT);
  console.log(`语料：${all.length} 句可用，取前 ${sentences.length} 句；词表 ${dictionary.size} 条`);
  console.log(`机翻来源：${MT}；模型：${MODEL}\n`);

  let external = new Map();
  if (MT === 'google') {
    const translator = new MachineTranslator({ cacheFile: CACHE_FILE });
    await translator.load();
    try {
      external = await translator.translateParagraphs(sentences);
      await translator.save();
      const stats = translator.stats;
      console.log(
        `谷歌机翻成功：${sentences.length} 句 / ${stats.requests} 次请求（缓存命中 ${stats.cacheHits}，重试 ${stats.retries}）\n`,
      );
    } catch (error) {
      console.log(`✗ 谷歌机翻不可用：${error.message}`);
      console.log('  实测该免费接口在十来个请求后就把来源 IP 硬封（退避重试 40 秒仍 429），');
      console.log('  所以它只能算「有则更好」的旁路，不能当每页依赖。\n');
    }
  }

  const llm = new LocalLlm({ model: MODEL }).start();
  const summary = {
    onePass: { candidates: 0, answered: 0, strict: 0, loose: 0, none: 0, ms: 0 },
    twoPass: { candidates: 0, answered: 0, strict: 0, loose: 0, none: 0, ms: 0 },
    parseFailures: 0,
    compared: 0,
    agreed: 0,
  };
  let processed = 0;

  try {
    for (const [index, sentence] of sentences.entries()) {
      const words = pickWords(sentence, dictionary, WORDS_PER_SENTENCE);
      if (words.length === 0) continue;
      processed += 1;
      const externalTranslation =
        [...external.entries()].find(
          ([source]) => sentence.includes(source) || source.includes(sentence),
        )?.[1] ?? '';

      console.log('─'.repeat(100));
      console.log(`[${index + 1}] ${sentence.length > 160 ? `${sentence.slice(0, 160)}…` : sentence}`);
      if (externalTranslation) console.log(`    谷歌机翻：${externalTranslation}`);

      const oneStarted = Date.now();
      const oneRaw = await llm.ask(SYSTEM, buildEndToEndPrompt(sentence, words));
      const oneMs = Date.now() - oneStarted;
      if (index === 0) console.log(`    （首次调用含模型加载：${oneMs}ms）`);
      const oneParsed = parseJsonObject(oneRaw);
      if (!oneParsed) summary.parseFailures += 1;
      const one = splitEndToEnd(oneParsed);

      const translationForTwo = externalTranslation || one.translation;
      const twoStarted = Date.now();
      const twoRaw = translationForTwo
        ? await llm.ask(SYSTEM, buildAlignedPrompt(sentence, translationForTwo, words))
        : '';
      const twoMs = Date.now() - twoStarted;
      const twoParsed = parseJsonObject(twoRaw);
      if (translationForTwo && !twoParsed) summary.parseFailures += 1;
      const two = new Map();
      for (const [word, gloss] of Object.entries(twoParsed ?? {})) {
        if (typeof gloss === 'string' && gloss.trim() !== '') {
          two.set(word.toLowerCase(), { gloss: gloss.trim() });
        }
      }

      console.log(`    一次通过译文：${one.translation || '（模型没给译文）'}`);
      console.log('    ┌──────────────┬──────────────┬────────────────────┬────────────────────┐');
      console.log('    │ 词           │ 词表参考     │ 一次通过           │ 两段式对齐         │');
      console.log('    ├──────────────┼──────────────┼────────────────────┼────────────────────┤');
      for (const word of words) {
        const reference = dictionary.get(word)?.gloss ?? '—';
        const mark = (gloss, translation) => {
          if (!gloss) return '·';
          return translation.includes(gloss) ? `${gloss} ✓` : `${gloss} ✗`;
        };
        const oneGloss = one.glosses.get(word)?.gloss ?? '';
        const twoGloss = two.get(word)?.gloss ?? '';
        if (reference !== '—' && oneGloss) {
          summary.compared += 1;
          const shared = [...oneGloss].filter((char) => reference.includes(char)).length;
          if (shared >= Math.min(2, oneGloss.length)) summary.agreed += 1;
        }
        console.log(
          `    │ ${cell(word, 12)} │ ${cell(reference, 12)} │ ${cell(mark(oneGloss, one.translation), 18)} │ ${cell(mark(twoGloss, translationForTwo), 18)} │`,
        );
      }
      console.log('    └──────────────┴──────────────┴────────────────────┴────────────────────┘');

      const oneScore = score({ words, translation: one.translation, results: one.glosses });
      const twoScore = score({ words, translation: translationForTwo, results: two });
      summary.onePass.candidates += oneScore.candidates;
      summary.onePass.answered += oneScore.answered;
      summary.onePass.strict += oneScore.strict;
      summary.onePass.loose += oneScore.loose;
      summary.onePass.none += oneScore.none;
      summary.onePass.ms += oneMs;
      summary.twoPass.candidates += twoScore.candidates;
      summary.twoPass.answered += twoScore.answered;
      summary.twoPass.strict += twoScore.strict;
      summary.twoPass.loose += twoScore.loose;
      summary.twoPass.none += twoScore.none;
      summary.twoPass.ms += twoMs;
    }
  } finally {
    llm.stop();
  }

  const rate = (bucket) => ({
    coverage: bucket.candidates === 0 ? 0 : bucket.answered / bucket.candidates,
    strict: bucket.answered === 0 ? 0 : bucket.strict / bucket.answered,
    loose: bucket.answered === 0 ? 0 : (bucket.strict + bucket.loose) / bucket.answered,
    none: bucket.answered === 0 ? 0 : bucket.none / bucket.answered,
    avgMs: processed === 0 ? 0 : Math.round(bucket.ms / processed),
  });
  const one = rate(summary.onePass);
  const two = rate(summary.twoPass);

  console.log(`\n${'='.repeat(100)}`);
  console.log(`候选词合计 ${summary.onePass.candidates} 个，处理 ${processed} 句\n`);
  console.log('策略          覆盖率          严格对齐(释义原样在译文里)   宽松对齐(前两字命中)   完全对不上   平均延迟');
  const line = (label, r) =>
    `${label}${bar(r.coverage)} ${(r.coverage * 100).toFixed(0).padStart(3)}%   ${bar(r.strict)} ${(r.strict * 100).toFixed(0).padStart(3)}%              ${bar(r.loose)} ${(r.loose * 100).toFixed(0).padStart(3)}%        ${bar(r.none)} ${(r.none * 100).toFixed(0).padStart(3)}%   ${r.avgMs}ms/句`;
  console.log(line('一次通过      ', one));
  console.log(line('两段式        ', two));
  if (summary.compared > 0) {
    console.log(
      `\n与词表对照：${summary.compared} 个词有参考释义，其中 ${summary.agreed} 个（${((summary.agreed / summary.compared) * 100).toFixed(0)}%）模型释义与词表不矛盾（弱指标，看上面的表更准）`,
    );
  }
  console.log(`JSON 解析失败 ${summary.parseFailures} 次`);
}

await main();
