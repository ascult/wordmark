/**
 * 原型：词典义匹配实际译文 —— 方法 vs 小模型 的正面对照。
 *
 * 【原型代码，不是生产实现】
 *
 * 同一批「词表已收录」的词，两种产出方式：
 *   方法  用词典义去实际译文里匹配出对应片段（纯算法，无模型判断）
 *   模型  让小模型直接给该词在本句中的释义
 *
 * 关键对比：方法产出的释义**按构造**一定与实际译文一致（它就是译文里的片段），
 * 代价是只覆盖「词典义在这句译文里还找得到」的词；模型覆盖率高，但会有
 * 一部分释义在译文里找不到对应（前面实测约 1/3）。
 *
 * 用法：
 *   npm run proto:match
 *   npm run proto:match -- --model=mlx-community/Qwen2.5-0.5B-Instruct-4bit
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm, SYSTEM, buildEndToEndPrompt, parseJsonObject, splitEndToEnd } from './align.mjs';
import { alignSentence, matchWord, splitSenses } from './match.mjs';
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
const MIN_SCORE = Number(flag('min-score', 0.5));
/** 是否让小模型只为每个词「列举候选说法」（不做判断），再由方法去译文里匹配。 */
const EXPAND = args.includes('--expand');

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
  const items = [];
  for (const sentence of all) {
    if (items.length >= SENTENCES) break;
    const words = candidateWords(sentence).filter((word) => dictionary.has(word)).slice(0, WORDS);
    if (words.length >= 2) items.push({ sentence, words });
  }
  console.log(`模型（只用来产出译文与对照释义）：${MODEL}`);
  console.log(`样本：${items.length} 句；匹配阈值 min-score=${MIN_SCORE}\n`);

/** 让模型列举候选中文说法——它只提供候选，判断仍由匹配方法做。 */
function buildCandidatePrompt(sentence, translation, words) {
  return [
    '英文句子：',
    sentence,
    '',
    '它的中文译文：',
    translation,
    '',
    `请为下面每个英文单词列出 2 到 4 个它在这句话里可能对应的中文说法（同义词也算）：${words.join(', ')}`,
    '',
    '规则：',
    '1. 每个词的多个说法之间用 / 分隔。',
    '2. 必须是中文词，2 到 6 个字，不要写英文、不要解释。',
    '3. 只输出 JSON，形如：{"word":"说法1/说法2"}',
    '',
    'JSON：',
  ].join('\n');
}

  const llm = new LocalLlm({ model: MODEL }).start();
  const tally = {
    words: 0,
    exact: 0,
    lcs: 0,
    none: 0,
    llmAnswered: 0,
    agree: 0,
    llmInTranslation: 0,
    methodDifferentFromDictionary: 0,
  };
  const disagreements = [];
  const tallyBaseline = { located: 0 };
  const tallyExpand = { words: 0, located: 0, exact: 0, lcs: 0 };

  try {
    const warm = Date.now();
    await llm.ask(SYSTEM, buildEndToEndPrompt(items[0].sentence, items[0].words));
    console.log(`预热（含模型加载）：${Date.now() - warm}ms\n`);

    for (const [index, item] of items.entries()) {
      const started = Date.now();
      const parsed = parseJsonObject(await llm.ask(SYSTEM, buildEndToEndPrompt(item.sentence, item.words)));
      const elapsed = Date.now() - started;
      const llmOut = splitEndToEnd(parsed);
      const translation = llmOut.translation;

      // 基线：只用词典义
      const baseline = alignSentence({
        words: item.words,
        dictionary,
        translation,
        minScore: MIN_SCORE,
      });

      // 扩展：词典义 ∪ 模型列的候选说法，仍由方法去译文里匹配
      let matches = baseline;
      if (EXPAND) {
        const expandRaw = await llm.ask(SYSTEM, buildCandidatePrompt(item.sentence, translation, item.words));
        const candidates = new Map();
        for (const [word, value] of Object.entries(parseJsonObject(expandRaw) ?? {})) {
          if (typeof value !== 'string') continue;
          const list = value
            .split(/[/／、，,;；]/)
            .map((part) => part.replace(/[^\u4e00-\u9fff]/g, '').trim())
            .filter((part) => [...part].length >= 2);
          if (list.length > 0) candidates.set(word.toLowerCase(), list);
        }
        matches = new Map();
        const content = item.words.filter((word) => dictionary.has(word));
        content.forEach((word, position) => {
          const ratio = content.length <= 1 ? 0.5 : position / (content.length - 1);
          const pool = [...splitSenses(dictionary.get(word).gloss), ...(candidates.get(word) ?? [])];
          let best = null;
          for (const candidate of pool) {
            const hit = matchWord(candidate, translation, { positionRatio: ratio, minScore: MIN_SCORE });
            if (!hit) continue;
            if (best === null || hit.key > best.key) best = { ...hit, source: candidates.get(word)?.includes(candidate) ? 'llm' : 'dict' };
          }
          if (best) matches.set(word, best);
          // 扩展模式下基线结果单独记账
          if (baseline.has(word)) tallyBaseline.located += 1;
        });
        tallyExpand.located += content.length === 0 ? 0 : matches.size;
        tallyExpand.words += content.length;
        for (const hit of matches.values()) {
          if (hit.kind === 'exact') tallyExpand.exact += 1;
          else tallyExpand.lcs += 1;
        }
      }

      console.log('─'.repeat(104));
      console.log(`[${index + 1}] ${item.sentence.length > 140 ? `${item.sentence.slice(0, 140)}…` : item.sentence}`);
      console.log(`    实际译文：${translation || '（未取到）'}    [${elapsed}ms]`);
      console.log('    ┌──────────────┬──────────────┬────────────────────┬────────────────────┐');
      console.log('    │ 词           │ 词典义       │ 方法：匹配到的片段 │ 模型：直出的释义   │');
      console.log('    ├──────────────┼──────────────┼────────────────────┼────────────────────┤');
      for (const word of item.words) {
        const reference = dictionary.get(word).gloss;
        const hit = matches.get(word);
        const llmGloss = llmOut.glosses.get(word)?.gloss ?? '';
        tally.words += 1;
        if (hit?.kind === 'exact') tally.exact += 1;
        else if (hit?.kind === 'lcs') tally.lcs += 1;
        else tally.none += 1;
        if (llmGloss) tally.llmAnswered += 1;
        if (llmGloss && translation.includes(llmGloss)) tally.llmInTranslation += 1;
        if (hit && llmGloss && hit.span === llmGloss) tally.agree += 1;
        if (hit && hit.span !== reference) tally.methodDifferentFromDictionary += 1;
        if (hit && llmGloss && hit.span !== llmGloss) {
          disagreements.push({ word, reference, span: hit.span, kind: hit.kind, llmGloss, translation });
        }
        const methodCell = hit ? `${hit.span} (${hit.kind},${hit.score.toFixed(2)})` : '✗ 未匹配';
        const llmCell = llmGloss ? llmGloss : '·';
        console.log(
          `    │ ${cell(word, 12)} │ ${cell(reference, 12)} │ ${cell(methodCell, 18)} │ ${cell(llmCell, 18)} │`,
        );
      }
      console.log('    └──────────────┴──────────────┴────────────────────┴────────────────────┘');
    }
  } finally {
    llm.stop();
  }

  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  const located = tally.exact + tally.lcs;
  console.log(`\n${'='.repeat(104)}`);
  console.log(`共 ${tally.words} 个词（全部词表已收录）\n`);
  console.log(`方法：词典义在实际译文里定位到   ${pct(located, tally.words)}  （原样命中 ${tally.exact} / 子串命中 ${tally.lcs} / 对不上 ${tally.none}）`);
  console.log(`  其中释义与词典义不同的            ${pct(tally.methodDifferentFromDictionary, located)}  —— 原样命中时它自然等于词典义；子串命中说明译文只保留了义项的一部分`);
  console.log(`  **与译文一致率 100%（构造保证）**：标注片段本身就是译文里的子串`);
  console.log(`模型：给出释义的比例             ${pct(tally.llmAnswered, tally.words)}`);
  console.log(`  其中释义能在译文里找到的          ${pct(tally.llmInTranslation, tally.llmAnswered)}  —— 剩下的是「与译文对不上」的释义`);
  console.log(`两者给出一致释义的比例            ${pct(tally.agree, tally.words)}`);

  if (EXPAND) {
    console.log(`\n【扩展候选后】只统计方法能定位的比例（共 ${tallyExpand.words} 个词）`);
    console.log(`  词典义单独            ${pct(tallyBaseline.located, tallyExpand.words)}`);
    console.log(`  词典义 ∪ 模型候选      ${pct(tallyExpand.located, tallyExpand.words)}  （原样命中 ${tallyExpand.exact} / 子串命中 ${tallyExpand.lcs}）`);
    console.log('  注意：候选由模型列举，但「用哪个候选」仍由匹配方法在译文里定位决定');
  }

  if (disagreements.length > 0) {
    console.log(`\n方法 与 模型 不一致的 ${disagreements.length} 处（看谁更贴合译文）：`);
    for (const item of disagreements.slice(0, 12)) {
      console.log(`  ${cell(item.word, 14)} 词典「${item.reference}」 | 方法「${item.span}」(${item.kind}) | 模型「${item.llmGloss}」`);
    }
  }
}

await main();
