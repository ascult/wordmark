/**
 * 原型：用小模型「挑选」符合语境的正确词典义。
 *
 * 【原型代码，不是生产实现】
 *
 * 与生成式方案的区别：模型的输出是**义项序号**，不是一个新造的释义。
 * 好处有三：任务变成选择题（小模型可靠得多）、输出极短（延迟低）、
 * 结果永远是真实词典义（质量有下限、可解释）。
 *
 * 三种挑选方式同台对比：
 *   方法    在译文里找哪个义项出现了（纯算法，无模型）
 *   模型A   只给句子 + 义项，让模型选（不给译文）
 *   模型B   额外给出这句话的实际译文再让它选（验证「用译文辅助」是否值得）
 *
 * 客观指标：选中的义项里是否有片段**确实出现在该句译文里**——
 * 这是「选对了语境义」的可自动判定代理。
 *
 * 用法：
 *   npm run proto:select
 *   npm run proto:select -- --model=mlx-community/Qwen2.5-1.5B-Instruct-4bit
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalLlm, SYSTEM, buildEndToEndPrompt, parseJsonObject, splitEndToEnd } from './align.mjs';
import { matchCandidate } from './match.mjs';
import { candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const MODEL = flag('model', 'mlx-community/Qwen2.5-1.5B-Instruct-4bit');
const SENTENCES = Number(flag('sentences', 6));
const WORDS = Number(flag('words', 2));
const MAX_SENSES = Number(flag('max-senses', 5));

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

/** 选择题提示词；withTranslation 为真时把实际译文也给模型。 */
function buildChoicePrompt(sentence, items, translation) {
  const lines = ['英文句子：', sentence, ''];
  if (translation) lines.push('这句话的实际中文译文：', translation, '');
  lines.push('请判断下面每个单词在这句话里的意思，从它给出的义项里选一个，只写序号。', '');
  for (const [word, senses] of items) {
    lines.push(`${word}:`);
    senses.forEach((sense, index) => lines.push(`  ${index + 1}) ${sense}`));
  }
  lines.push('', '规则：每个单词输出一行，格式为「单词=序号」，例如 engine=1。不要解释。', '', '输出：');
  return lines.join('\n');
}

/** 解析「单词=序号」。 */
function parseChoices(raw) {
  const picked = new Map();
  for (const line of String(raw).split('\n')) {
    const match = line.match(/([A-Za-z][A-Za-z'’-]*)\s*[=:：]\s*(\d+)/);
    if (!match) continue;
    picked.set(match[1].toLowerCase(), Number(match[2]));
  }
  return picked;
}

function cell(text, width) {
  const visible = [...text];
  if (visible.length > width) return `${visible.slice(0, width - 1).join('')}…`;
  return text + ' '.repeat(Math.max(0, width - visible.length));
}

/** 义项里是否有片段出现在译文里（判定「选对了语境义」的代理）。 */
function senseFitsTranslation(sense, translation) {
  if (!translation) return null;
  for (const atom of sense.split('/')) {
    const hit = matchCandidate(atom, translation, { minLcs: 2 });
    if (hit && hit.score >= 0.5) return true;
  }
  return false;
}

async function main() {
  const sensesTable = JSON.parse(await readFile(path.join(__dirname0(), 'senses.json'), 'utf8'));

  const all = await loadSentences();
  const items = [];
  for (const sentence of all) {
    if (items.length >= SENTENCES) break;
    const words = candidateWords(sentence).filter((word) => sensesTable[word]?.length >= 2).slice(0, WORDS);
    if (words.length >= 1) items.push({ sentence, words });
  }
  console.log(`模型：${MODEL}`);
  console.log(`样本：${items.length} 句，每句最多 ${WORDS} 个「有多个义项」的词\n`);

  const llm = new LocalLlm({ model: MODEL }).start();
  const tally = {
    words: 0,
    methodPicked: 0,
    methodFits: 0,
    aValid: 0,
    aFits: 0,
    aUnknownFit: 0,
    bValid: 0,
    bFits: 0,
    bUnknownFit: 0,
    agreeAB: 0,
    methodLatency: 0,
    aLatency: 0,
    bLatency: 0,
  };

  try {
    const warm = Date.now();
    await llm.ask(SYSTEM, buildEndToEndPrompt(items[0].sentence, items[0].words));
    console.log(`预热（含模型加载）：${Date.now() - warm}ms\n`);

    for (const [index, item] of items.entries()) {
      const choices = item.words.map((word) => [word, sensesTable[word].slice(0, MAX_SENSES)]);

      // 取实际译文（顺带拿到模型的直出释义作参考）
      const tStart = Date.now();
      const one = splitEndToEnd(parseJsonObject(await llm.ask(SYSTEM, buildEndToEndPrompt(item.sentence, item.words))));
      const translationMs = Date.now() - tStart;
      const translation = one.translation;

      // 方法挑选：译文里出现了哪个义项
      const methodStart = Date.now();
      const methodPicks = new Map();
      for (const [word, senses] of choices) {
        senses.forEach((sense, position) => {
          const fits = senseFitsTranslation(sense, translation);
          if (fits && !methodPicks.has(word)) methodPicks.set(word, position);
        });
      }
      const methodMs = Date.now() - methodStart;

      // 模型 A：不给译文
      const aStart = Date.now();
      const aPicks = parseChoices(await llm.ask(SYSTEM, buildChoicePrompt(item.sentence, choices, null)));
      const aMs = Date.now() - aStart;
      // 模型 B：给译文
      const bStart = Date.now();
      const bPicks = parseChoices(await llm.ask(SYSTEM, buildChoicePrompt(item.sentence, choices, translation)));
      const bMs = Date.now() - bStart;

      console.log('─'.repeat(108));
      console.log(`[${index + 1}] ${item.sentence.length > 120 ? `${item.sentence.slice(0, 120)}…` : item.sentence}`);
      console.log(`    实际译文：${translation || '（未取到）'}`);
      console.log('    ┌──────────────┬──────────────────────────────┬────────┬────────┬────────┐');
      console.log('    │ 词           │ 义项                         │ 方法   │ 模型A  │ 模型B  │');
      console.log('    ├──────────────┼──────────────────────────────┼────────┼────────┼────────┤');
      for (const [word, senses] of choices) {
        const methodIndex = methodPicks.has(word) ? methodPicks.get(word) : -1;
        const aIndex = (aPicks.get(word) ?? 0) - 1;
        const bIndex = (bPicks.get(word) ?? 0) - 1;
        const label = (position) =>
          position >= 0 && position < senses.length ? `${position + 1})${senses[position]}` : '·';

        tally.words += 1;
        if (methodIndex >= 0) {
          tally.methodPicked += 1;
          if (senseFitsTranslation(senses[methodIndex], translation)) tally.methodFits += 1;
        }
        if (aIndex >= 0 && aIndex < senses.length) {
          tally.aValid += 1;
          const fits = senseFitsTranslation(senses[aIndex], translation);
          if (fits === true) tally.aFits += 1;
          if (fits === false) tally.aUnknownFit += 1;
        }
        if (bIndex >= 0 && bIndex < senses.length) {
          tally.bValid += 1;
          const fits = senseFitsTranslation(senses[bIndex], translation);
          if (fits === true) tally.bFits += 1;
          if (fits === false) tally.bUnknownFit += 1;
        }
        if (aIndex >= 0 && bIndex >= 0 && aIndex === bIndex) tally.agreeAB += 1;

        console.log(
          `    │ ${cell(word, 12)} │ ${cell(senses.join(' | '), 28)} │ ${cell(label(methodIndex), 6)} │ ${cell(aIndex >= 0 && aIndex < senses.length ? String(aIndex + 1) : '·', 6)} │ ${cell(bIndex >= 0 && bIndex < senses.length ? String(bIndex + 1) : '·', 6)} │`,
        );
      }
      console.log('    └──────────────┴──────────────────────────────┴────────┴────────┴────────┘');
      tally.methodLatency += methodMs;
      tally.aLatency += aMs;
      tally.bLatency += bMs;
      console.log(`    延迟：取译文 ${translationMs}ms / 方法 ${methodMs}ms / 模型A ${aMs}ms / 模型B ${bMs}ms`);
    }
  } finally {
    llm.stop();
  }

  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(0)}%`);
  console.log(`\n${'='.repeat(108)}`);
  console.log(`共 ${tally.words} 个词（都有多个义项）\n`);
  console.log('挑选方式              有效作答            选中的义项确实出现在译文里      每条耗时（均）');
  console.log(
    `方法（找译文里的义项）  ${pct(tally.methodPicked, tally.words).padStart(4)}              ${pct(tally.methodFits, tally.methodPicked).padStart(4)}                     ${Math.round(tally.methodLatency / Math.max(1, tally.words))}ms（纯算法）`,
  );
  console.log(
    `模型A（不给译文）       ${pct(tally.aValid, tally.words).padStart(4)}              ${pct(tally.aFits, tally.aValid).padStart(4)}                     ${Math.round(tally.aLatency / Math.max(1, tally.words))}ms`,
  );
  console.log(
    `模型B（给译文）         ${pct(tally.bValid, tally.words).padStart(4)}              ${pct(tally.bFits, tally.bValid).padStart(4)}                     ${Math.round(tally.bLatency / Math.max(1, tally.words))}ms`,
  );
  console.log(`\n模型A 与 模型B 选择一致 ${pct(tally.agreeAB, tally.words)}`);
  console.log('注：「确实出现在译文里」是代理指标——它只说明该义项与该句译文相容；');
  console.log('    译文本身若漏译/改写，选得再对也会被判为不相容。');
}

function __dirname0() {
  return path.dirname(fileURLToPath(import.meta.url));
}

await main();
