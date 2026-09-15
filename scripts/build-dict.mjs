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

  await writeFile(OUT_FILE, `${JSON.stringify(entries, null, 0)}\n`, 'utf8');

  const altForms = entries.reduce((sum, entry) => sum + (entry.alt?.length ?? 0), 0);
  console.log(`✓ 合并 ${entries.length} 条词条 → ${path.relative(ROOT, OUT_FILE)}`);
  for (const { file, count } of perFile) console.log(`  · ${file}: ${count} 条`);
  console.log(
    `  难度分布：${LEVELS.map((level) => `${level} ${byLevel[level]}`).join(' / ')}；不规则变体 ${altForms} 个`,
  );
  if (duplicates.length > 0) {
    console.log(`  跳过重复 ${duplicates.length} 条：${duplicates.slice(0, 8).join(', ')}${duplicates.length > 8 ? ' …' : ''}`);
  }
  if (droppedAlts.length > 0) {
    console.log(`  去掉与正式词条冲突的 alt ${droppedAlts.length} 个：${droppedAlts.slice(0, 8).join(', ')}${droppedAlts.length > 8 ? ' …' : ''}`);
  }
}

await main();
