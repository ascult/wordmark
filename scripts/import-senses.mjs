/**
 * 从上游词库恢复「一个词多个义项」→ `data/senses/<难度>.json`。
 *
 * 打分服务（`tools/sense-server`，目前还在 `prototype/mt-align/xenc/serve.py`）要用它做
 * 「义项选择题」，所以这份表是那条通路的**必需输入**，必须以源数据的身份入库：
 * 生成器需要一份外部 TypeWords 克隆，但产物入库之后 `git clone` 就能重建整条链路。
 *
 * 形状：`{ "<词元>": ["义项", …] }`，每词 ≤6 条。义项由最多 3 个「原子」用 `/` 连接，
 * 单原子 ≤10 字，因此单义项的结构上限是 3×10+2 = 32 字（`src` 侧的校验按这个上限来，
 * 它与词表里那条 ≤14 字的 `gloss` 是两回事：后者是压缩过的展示释义）。
 *
 * 注意：**不要把这份表放进 `data/parts/` 或 `data/imported/`**——`build-dict.mjs` 会把那两个
 * 目录下的每个 JSON 当成词条数组校验，而义项表没有 pos/gloss/level，会让构建直接失败。
 *
 * 用法：
 *   node scripts/import-senses.mjs <TypeWords 的 CET4_T.json> <难度> <输出路径>
 * 例：
 *   node scripts/import-senses.mjs \
 *     .tmp-ref/TypeWords/public/dicts/en/word/CET4_T.json cet4 data/senses/cet4.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_SENSES = 6;
const MAX_ATOM_CHARS = 10;

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
    .map((atom) => ([...atom].length > MAX_ATOM_CHARS ? [...atom].slice(0, MAX_ATOM_CHARS).join('') : atom));
  const unique = [...new Set(atoms)].slice(0, 3);
  return unique.length === 0 ? null : unique.join('/');
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const [source, level, out] = process.argv.slice(2);
  if (!source || !level || !out) {
    fail('用法：node scripts/import-senses.mjs <源 JSON> <难度> <输出路径>');
  }
  if (!['basic', 'cet4', 'cet6', 'ielts', 'gre'].includes(level)) {
    fail(`难度必须是 basic/cet4/cet6/ielts/gre 之一，收到 ${level}`);
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    fail(`读不到或解析不了源文件 ${source}：${error.message}`);
  }
  if (!Array.isArray(raw)) fail(`${source} 顶层必须是数组`);

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

  const target = path.join(ROOT, out);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(table)}\n`, 'utf8');
  console.log(`✓ ${Object.keys(table).length} 个词，其中 ${multi} 个有 2 个以上义项 → ${out}`);
  for (const word of ['engine', 'ambitious', 'whatever', 'curious', 'cancel', 'abstract']) {
    if (table[word]) console.log(`  ${word.padEnd(12)} ${table[word].join(' | ')}`);
  }
}

await main();
