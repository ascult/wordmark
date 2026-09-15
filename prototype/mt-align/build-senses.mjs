/**
 * 原型：从 TypeWords 原始数据恢复「一个词多个义项」，供小模型做选择题。
 *
 * 【原型代码，不是生产实现】
 *
 * 现有词表 dict.zh.json 每个词只有一条压缩过的释义（≤14 字），没有义项可选。
 * 但上游 CET4_T.json 的 trans[].cn 里本来就有多个义项（用「；」分隔），
 * 这里把它们拆出来，产出 word → [义项…]，每个义项 ≤10 字，最多 6 个。
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = path.join(ROOT, '.tmp-ref', 'TypeWords', 'public', 'dicts', 'en', 'word', 'CET4_T.json');
const OUT = path.join(ROOT, 'prototype', 'mt-align', 'senses.json');
const MAX_SENSES = 6;
const MAX_CHARS = 10;

/**
 * 把一个义项组整理成候选：组内同义词用 / 分隔，便于人看也便于模型区分。
 * 例：「发动机，引擎」→「发动机/引擎」（这是一个义项，不是两个）。
 */
function cleanGroup(text) {
  const atoms = String(text)
    .normalize('NFKC')
    .replace(/<[^>]*>/g, '')
    .replace(/[[【][^\]】]*[\]】]/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/^[a-zA-Z.]+/, '')
    .split(/[，,、]/)
    .map((atom) => atom.replace(/[^\u4e00-\u9fff]/g, '').trim())
    .filter((atom) => atom !== '')
    .map((atom) => ([...atom].length > MAX_CHARS ? [...atom].slice(0, MAX_CHARS).join('') : atom));
  const unique = [...new Set(atoms)].slice(0, 3);
  return unique.length === 0 ? null : unique.join('/');
}

const raw = JSON.parse(await readFile(SOURCE, 'utf8'));
const table = {};
let multi = 0;
for (const entry of raw) {
  const word = String(entry.word ?? '').trim().toLowerCase();
  if (!/^[a-z]+$/.test(word)) continue;
  const senses = [];
  for (const item of entry.trans ?? []) {
    for (const part of String(item.cn ?? '').split(/[；;]/)) {
      const sense = cleanGroup(part);
      if (sense && !senses.includes(sense)) senses.push(sense);
      if (senses.length >= MAX_SENSES) break;
    }
    if (senses.length >= MAX_SENSES) break;
  }
  if (senses.length === 0) continue;
  table[word] = senses;
  if (senses.length >= 2) multi += 1;
}

await writeFile(OUT, `${JSON.stringify(table)}\n`, 'utf8');
console.log(`✓ ${Object.keys(table).length} 个词，其中 ${multi} 个有 2 个以上义项 → ${path.relative(ROOT, OUT)}`);
const samples = ['engine', 'ambitious', 'whatever', 'curious', 'cancel', 'abstract'];
for (const word of samples) {
  if (table[word]) console.log(`  ${word.padEnd(12)} ${table[word].join(' | ')}`);
}
