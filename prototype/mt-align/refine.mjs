/**
 * 原型：词典义 × 语境义——让模型在词典释义的基础上按语境校正。
 *
 * 【原型代码，不是生产实现】
 *
 * 要回答的问题：
 *   1. 词典给的释义，在真实句子里到底有多大比例是「语境里也对」的？
 *   2. 把词典义喂给模型，它能不能只在答错时才改？（改得对不对要人眼判断）
 *   3. 不给词典义时，模型会自己收敛到词典义吗？（差多少 = 词典的贡献）
 *   4. 多小的模型够用？（0.5B / 1.5B 对照；3B 太大不做）
 *
 * 用法：
 *   npm run proto:refine
 *   npm run proto:refine -- --model=mlx-community/Qwen2.5-0.5B-Instruct-4bit
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LocalLlm,
  SYSTEM,
  buildEndToEndPrompt,
  buildRefinePrompt,
  parseJsonObject,
  splitEndToEnd,
} from './align.mjs';
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

function cell(text, width) {
  const visible = [...text];
  if (visible.length > width) return `${visible.slice(0, width - 1).join('')}…`;
  return text + ' '.repeat(Math.max(0, width - visible.length));
}

async function main() {
  const dictionary = new Map(
    JSON.parse(await readFile(path.join(ROOT, 'src', 'data', 'dict.zh.json'), 'utf8')).map((e) => [
      e.word,
      e,
    ]),
  );
  const all = await loadSentences();

  // 只挑词表收录的词：这一轮问的就是「词典义在语境里对不对」
  const items = [];
  for (const sentence of all) {
    if (items.length >= SENTENCES) break;
    const words = candidateWords(sentence).filter((word) => dictionary.has(word)).slice(0, WORDS);
    if (words.length >= 2) items.push({ sentence, words });
  }
  console.log(`模型：${MODEL}`);
  console.log(`样本：${items.length} 句，每句最多 ${WORDS} 个「词表已收录」的词\n`);

  const llm = new LocalLlm({ model: MODEL }).start();
  const tally = {
    words: 0,
    keptDictionary: 0,   // B 原样保留词典义
    aEqualsDictionary: 0, // 不给词典时模型也给出同样的释义
    bDiffersFromA: 0,     // 给了词典后改了口
    aStrict: 0,
    bStrict: 0,
    answeredA: 0,
    answeredB: 0,
    parseFailures: 0,
  };
  const overrides = [];

  try {
    const warm = Date.now();
    await llm.ask(SYSTEM, buildEndToEndPrompt(items[0].sentence, items[0].words));
    console.log(`预热（含模型加载）：${Date.now() - warm}ms\n`);

    for (const [index, item] of items.entries()) {
      const pairs = item.words.map((word) => [word, dictionary.get(word).gloss]);

      // A：不给词典义（基线与「词典贡献」的对照）
      const aStart = Date.now();
      const aParsed = parseJsonObject(await llm.ask(SYSTEM, buildEndToEndPrompt(item.sentence, item.words)));
      const aMs = Date.now() - aStart;
      if (!aParsed) tally.parseFailures += 1;
      const a = splitEndToEnd(aParsed);

      // B：给词典义，要求只在语境不符时改
      const bStart = Date.now();
      const bParsed = parseJsonObject(await llm.ask(SYSTEM, buildRefinePrompt(item.sentence, pairs)));
      const bMs = Date.now() - bStart;
      if (!bParsed) tally.parseFailures += 1;
      const b = splitEndToEnd(bParsed);

      console.log('─'.repeat(104));
      console.log(`[${index + 1}] ${item.sentence.length > 150 ? `${item.sentence.slice(0, 150)}…` : item.sentence}`);
      console.log(`    A 译文：${a.translation || '（无）'}`);
      console.log(`    B 译文：${b.translation || '（无）'}`);
      console.log('    ┌──────────────┬──────────────┬────────────────────┬────────────────────┐');
      console.log('    │ 词           │ 词典义       │ A 不给词典义       │ B 给词典义(校正)   │');
      console.log('    ├──────────────┼──────────────┼────────────────────┼────────────────────┤');
      for (const [word, reference] of pairs) {
        const aGloss = a.glosses.get(word)?.gloss ?? '';
        const bGloss = b.glosses.get(word)?.gloss ?? '';
        tally.words += 1;
        if (aGloss) tally.answeredA += 1;
        if (bGloss) tally.answeredB += 1;
        if (aGloss === reference) tally.aEqualsDictionary += 1;
        if (bGloss === reference) tally.keptDictionary += 1;
        if (bGloss && aGloss && bGloss !== aGloss) tally.bDiffersFromA += 1;
        if (aGloss && a.translation.includes(aGloss)) tally.aStrict += 1;
        if (bGloss && b.translation.includes(bGloss)) tally.bStrict += 1;
        if (bGloss && bGloss !== reference) overrides.push({ word, reference, bGloss, aGloss, sentence: item.sentence });
        const mark = (gloss, translation) => (!gloss ? '·' : translation.includes(gloss) ? `${gloss} ✓` : `${gloss} ✗`);
        console.log(
          `    │ ${cell(word, 12)} │ ${cell(reference, 12)} │ ${cell(mark(aGloss, a.translation), 18)} │ ${cell(mark(bGloss, b.translation), 18)} │`,
        );
      }
      console.log('    └──────────────┴──────────────┴────────────────────┴────────────────────┘');
      console.log(`    延迟：A ${aMs}ms / B ${bMs}ms`);
    }
  } finally {
    llm.stop();
  }

  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`\n${'='.repeat(104)}`);
  console.log(`共 ${tally.words} 个词（全部是词表已收录的）\n`);
  console.log(`词典义在语境里被模型保留    ${pct(tally.keptDictionary, tally.words)}   （${tally.keptDictionary}/${tally.words}）—— 这个比例越高，说明词典义越"够用"`);
  console.log(`不给词典时模型也给出同一释义 ${pct(tally.aEqualsDictionary, tally.words)}   —— 差得越多，说明词典提供的信息越不可替代`);
  console.log(`给词典后改了口              ${pct(tally.bDiffersFromA, tally.words)}`);
  console.log(`严格对齐   A ${pct(tally.aStrict, tally.answeredA)}   B ${pct(tally.bStrict, tally.answeredB)}`);
  console.log(`JSON 解析失败 ${tally.parseFailures} 次`);

  if (overrides.length > 0) {
    console.log(`\n模型改写了词典义的 ${overrides.length} 处（对错要人眼看）：`);
    for (const item of overrides) {
      console.log(`  ${cell(item.word, 14)} 词典「${item.reference}」→ 模型「${item.bGloss}」${item.aGloss && item.aGloss !== item.bGloss ? `（不给词典时它给的是「${item.aGloss}」）` : ''}`);
    }
  }
}

await main();
