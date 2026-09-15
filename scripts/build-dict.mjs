/**
 * 合并词表 → `src/data/dict.zh.json`。
 *
 * 两个来源，优先级不同：
 * - `data/parts/*.json`   人工整理、逐条核对过的词条，**冲突时优先**；
 * - `data/imported/*.json` 从外部词库批量导入（见 scripts/import-typewords.mjs），
 *                          只补充 curated 没覆盖到的词。
 *
 * 之所以走「分片 → 合并」而不是手写一个大文件：多个来源可以并行产出，
 * 合并时统一校验；校验失败会让构建直接失败，坏数据进不了扩展。
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  { dir: path.join(ROOT, 'data', 'parts'), label: 'curated' },
  { dir: path.join(ROOT, 'data', 'imported'), label: 'imported' },
];
const OUT_FILE = path.join(ROOT, 'src', 'data', 'dict.zh.json');

const LEVELS = ['basic', 'cet4', 'cet6', 'ielts', 'gre'];
const MAX_GLOSS_CHARS = 14;
const SENSES_DIR = path.join(ROOT, 'data', 'senses');
const MAX_SENSES_PER_WORD = 6;
/**
 * 单个义项的长度上限。
 *
 * 这不是「展示用短释义」那条 14 字规则：义项是给打分器做选择题用的候选，
 * 由生成器把最多 3 个「原子」用 `/` 连接而成、单原子 ≤10 字，所以结构上限是 32。
 */
const MAX_SENSE_CHARS = 32;

function fail(message) {
  console.error(`✗ 词典校验失败：${message}`);
  process.exit(1);
}

function validate(entry, source) {
  if (typeof entry !== 'object' || entry === null) fail(`${source}: 条目不是对象`);
  const { word, pos, gloss, level, alt } = entry;
  if (typeof word !== 'string' || !/^[a-z]+$/.test(word)) {
    fail(`${source}: word 必须是小写 ASCII 字母，收到 ${JSON.stringify(word)}`);
  }
  if (typeof pos !== 'string' || pos.trim() === '') fail(`${source}: ${word} 缺少 pos`);
  if (typeof gloss !== 'string' || gloss.trim() === '') fail(`${source}: ${word} 缺少 gloss`);
  if ([...gloss].length > MAX_GLOSS_CHARS) fail(`${source}: ${word} 的释义超过 ${MAX_GLOSS_CHARS} 字`);
  if (!LEVELS.includes(level)) fail(`${source}: ${word} 的 level 非法：${level}`);
  if (alt !== undefined) {
    if (!Array.isArray(alt) || alt.some((item) => typeof item !== 'string' || !/^[a-z]+$/.test(item))) {
      fail(`${source}: ${word} 的 alt 必须是小写 ASCII 字母数组`);
    }
  }
  return {
    word,
    pos: pos.trim(),
    gloss: gloss.trim(),
    level,
    ...(alt === undefined || alt.length === 0 ? {} : { alt: [...new Set(alt)].sort() }),
  };
}

/**
 * 校验 `data/senses/*.json`（多义项表）。
 *
 * 它是打分服务的必需输入，坏了就没人能重建「为什么挑中这个义项」，所以和词表一样
 * 走 fail-fast。它**不并进 dict.zh.json**：义项表由打分服务持有，扩展不打包（见 ADR 0001）。
 */
async function checkSenses(heads) {
  let files;
  try {
    files = (await readdir(SENSES_DIR)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    // 没有多义项表也能构建：语境义是增强，不是扩展的必需品
    return null;
  }

  let words = 0;
  let senses = 0;
  for (const file of files) {
    const raw = await readFile(path.join(SENSES_DIR, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      fail(`data/senses/${file} 不是合法 JSON：${error.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(`data/senses/${file} 顶层必须是 { 词元: [义项…] }`);
    }
    for (const [word, list] of Object.entries(parsed)) {
      if (!/^[a-z]+$/.test(word)) fail(`${file}: 词元必须是小写 ASCII，收到 ${JSON.stringify(word)}`);
      if (!heads.has(word)) fail(`${file}: ${word} 不在词表里——多义项表不能凭空造词`);
      if (!Array.isArray(list) || list.length === 0) fail(`${file}: ${word} 的义项必须是非空数组`);
      if (list.length > MAX_SENSES_PER_WORD) fail(`${file}: ${word} 的义项超过 ${MAX_SENSES_PER_WORD} 条`);
      const seen = new Set();
      for (const sense of list) {
        if (typeof sense !== 'string' || sense.trim() === '') fail(`${file}: ${word} 有空义项`);
        if (!/[\u4e00-\u9fff]/.test(sense)) fail(`${file}: ${word} 的义项必须含中文，收到 ${JSON.stringify(sense)}`);
        if ([...sense].length > MAX_SENSE_CHARS) {
          fail(`${file}: ${word} 的义项超过 ${MAX_SENSE_CHARS} 字：${sense}`);
        }
        if (seen.has(sense)) fail(`${file}: ${word} 的义项重复：${sense}`);
        seen.add(sense);
      }
      words += 1;
      senses += list.length;
    }
  }
  return { files: files.length, words, senses };
}

async function main() {
  const byWord = new Map();
  const duplicates = [];
  const perFile = [];

  for (const source of SOURCES) {
    let files;
    try {
      files = (await readdir(source.dir)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      // imported 目录可以不存在（没有导入任何外部词库时）
      if (source.label === 'curated') fail(`读不到分片目录 ${source.dir}`);
      continue;
    }

    for (const file of files) {
      const raw = await readFile(path.join(source.dir, file), 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        fail(`${file} 不是合法 JSON：${error.message}`);
      }
      if (!Array.isArray(parsed)) fail(`${file} 顶层必须是数组`);

      const accepted = [];
      for (const item of parsed) {
        const entry = validate(item, file);
        const existing = byWord.get(entry.word);
        if (existing) {
          // 人工整理的分片先合并，因此这里一定是「导入的重复」被跳过
          duplicates.push(`${entry.word}（已有 ${existing.source}，跳过 ${source.label}/${file}）`);
          continue;
        }
        byWord.set(entry.word, { ...entry, source: `${source.label}/${file}` });
        accepted.push(entry.word);
      }
      perFile.push({ file: `${source.label}/${file}`, count: accepted.length });
    }
  }

  // 不变量：alt 变体不能同时是正式词条。
  // 冲突时以正式词条为准，去掉多余的 alt 并提示——这样「分片作者加了
  // 一个与既有 alt 同名的头词」不会让词表自相矛盾。
  const heads = new Set(byWord.keys());
  const droppedAlts = [];
  for (const [word, entry] of byWord) {
    if (!Array.isArray(entry.alt)) continue;
    const kept = entry.alt.filter((alt) => {
      if (!heads.has(alt)) return true;
      droppedAlts.push(`${alt}（原为 ${word} 的 alt）`);
      return false;
    });
    if (kept.length === 0) delete entry.alt;
    else entry.alt = kept;
  }

  const entries = [...byWord.values()]
    .map(({ source: _source, ...entry }) => entry)
    .sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

  const byLevel = {};
  for (const level of LEVELS) byLevel[level] = entries.filter((e) => e.level === level).length;

  const senses = await checkSenses(heads);

  await writeFile(OUT_FILE, `${JSON.stringify(entries, null, 0)}\n`, 'utf8');

  const altForms = entries.reduce((sum, entry) => sum + (entry.alt?.length ?? 0), 0);
  console.log(`✓ 合并 ${entries.length} 条词条 → ${path.relative(ROOT, OUT_FILE)}`);
  for (const { file, count } of perFile) console.log(`  · ${file}: ${count} 条`);
  console.log(
    `  难度分布：${LEVELS.map((level) => `${level} ${byLevel[level]}`).join(' / ')}；不规则变体 ${altForms} 个`,
  );
  if (senses) {
    console.log(
      `  多义项表 ${senses.files} 份：${senses.words} 个词 / ${senses.senses} 条义项（不打包进扩展，由打分服务持有）`,
    );
  }
  if (duplicates.length > 0) {
    console.log(`  跳过重复 ${duplicates.length} 条：${duplicates.slice(0, 8).join(', ')}${duplicates.length > 8 ? ' …' : ''}`);
  }
  if (droppedAlts.length > 0) {
    console.log(`  去掉与正式词条冲突的 alt ${droppedAlts.length} 个：${droppedAlts.slice(0, 8).join(', ')}${droppedAlts.length > 8 ? ' …' : ''}`);
  }
}

await main();
