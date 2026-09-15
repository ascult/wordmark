/**
 * 真实文章 → 「句子 × 多义词 × 候选义项」清单（端到端评测的输入侧）。
 *
 * 【原型代码，不是生产实现】
 *
 * 为什么切成两步：切句必须与**生产完全一致**，所以复用 `mt.mjs` 的 `splitSentences`
 * 与 `candidateWords`（生产渲染器就是走这两个函数）。打分则交给 MLX 的 Python 侧。
 * 两步之间用一份 JSON 交接，避免在 Python 里重写一遍切句逻辑而产生分布偏差。
 *
 * 用法：
 *   node prototype/mt-align/xenc/pick-candidates.mjs \
 *     --article=.tmp-articles/https_paulgraham_com_greatwork_html.html \
 *     --out=prototype/mt-align/xenc/annotate-input.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateWords, splitSentences } from '../mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};

const ARTICLE = flag('article', '.tmp-articles/https_paulgraham_com_greatwork_html.html');
const OUT = flag('out', 'prototype/mt-align/xenc/annotate-input.json');
const SENSES = flag('senses', 'data/senses/cet4.json');
/** 一句话里最多取几个目标词：真实文章里长句可能命中十来个，全打分会淹没输出。 */
const PER_SENTENCE = Number(flag('per-sentence', 3));
/** 句子太短则上下文不足，跳过（与生产一致的下限）。 */
const MIN_CHARS = Number(flag('min-chars', 40));

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, '\u2019')
    .replace(/&#8216;|&lsquo;/g, '\u2018')
    .replace(/&#8220;|&ldquo;/g, '\u201c')
    .replace(/&#8221;|&rdquo;/g, '\u201d')
    .replace(/&#8212;|&mdash;/g, '\u2014')
    .replace(/&#8211;|&ndash;/g, '\u2013')
    .replace(/\{\d+\}/g, ' ')
    .replace(/\s+/g, ' ');
}

async function main() {
  const senses = JSON.parse(await readFile(path.join(ROOT, SENSES), 'utf8'));
  const html = await readFile(path.join(ROOT, ARTICLE), 'utf8');
  const sentences = splitSentences(stripHtml(html));

  const items = [];
  for (const sentence of sentences) {
    if (sentence.length < MIN_CHARS) continue;
    const hits = candidateWords(sentence).filter((word) => (senses[word]?.length ?? 0) >= 2);
    for (const word of hits.slice(0, PER_SENTENCE)) {
      items.push({ sentence, word, senses: senses[word] });
    }
  }

  await writeFile(
    path.join(ROOT, OUT),
    JSON.stringify({ article: ARTICLE, sentences: sentences.length, items }, null, 2),
  );
  console.log(`${ARTICLE}`);
  console.log(`  句子 ${sentences.length} 条 → 需决策的（句子 × 多义词）${items.length} 个`);
  console.log(`  涉及 ${new Set(items.map((i) => i.word)).size} 个不同的词`);
  const ns = items.map((i) => i.senses.length);
  console.log(`  平均义项数 ${(ns.reduce((a, b) => a + b, 0) / Math.max(1, ns.length)).toFixed(2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
