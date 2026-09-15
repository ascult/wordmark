/**
 * 从外部词库（TypeWords 格式）导入并转换成 wordmark 的词表格式。
 *
 * 来源：https://github.com/zyronon/TypeWords （GPL-3.0）
 * 该仓库的词库放在 public/dicts/en/word/*.json，形如：
 *   { "word": "cancel", "trans": [ { "pos": "v.", "cn": "取消（计划好的事情）；终止，废除；…" } ] }
 *
 * 需要做的转换有两件：
 * 1. `cn` 是完整词典释义（常 30–80 字），wordmark 要的是 ≤14 字的内联短释义
 *    → 取第一个义项、按标点切出首段、去掉括号补充与专业标注；
 * 2. 只保留能真正匹配到网页 token 的词。分词器按连字符切词，
 *    所以 "well-known" / "call it off" 这类带连字符或空格的条目直接丢弃。
 *
 * 用法：
 *   node scripts/import-typewords.mjs <源 json> <难度> <输出文件> [--common=<常用词表> ...]
 *   例：node scripts/import-typewords.mjs \
 *         .tmp-ref/TypeWords/public/dicts/en/word/CET4_T.json cet4 data/imported/cet4.json \
 *         --common=data/reference/common-words-a.json --common=data/reference/common-words-b.json
 *
 * 传了 --common 之后，落在常用词表里的词会被标成 `basic`（默认不标注），
 * 其余才保留指定难度。这样整表导入不会把 ability / action 这类
 * 常见词糊满页面，而真正的 CET-4 生词默认就能用上。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** wordmark 的释义长度上限（与 scripts/build-dict.mjs 保持一致）。 */
const MAX_GLOSS_CHARS = 14;
/** 常用词表中命中的词会被归到这一档（默认不标注）。 */
const BASIC_LEVEL = 'basic';
/** 词性收敛：把 vt./vi. 之类统一成学习者更熟悉的形式。 */
const POS_MAP = {
  'vt.': 'v.',
  'vi.': 'v.',
  'v.': 'v.',
  aux: 'v.',
  'aux.': 'v.',
  'modal.': 'v.',
  'n.': 'n.',
  'adj.': 'adj.',
  'a.': 'adj.',
  'adv.': 'adv.',
  'ad.': 'adv.',
  'prep.': 'prep.',
  'conj.': 'conj.',
  'pron.': 'pron.',
  'num.': 'num.',
  'int.': 'int.',
  'interj.': 'int.',
  'art.': 'art.',
  'abbr.': 'abbr.',
};

const USAGE =
  '用法：node scripts/import-typewords.mjs <源 json> <难度 basic|cet4|cet6|ielts|gre> <输出文件> [--common=<常用词表> ...]';

/** 读取若干常用词表并合并成一个集合；文件可以是字符串数组或 { words: [] }。 */
async function loadCommonWords(files) {
  const set = new Set();
  for (const file of files) {
    const target = path.isAbsolute(file) ? file : path.join(ROOT, file);
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.words ?? []);
    let added = 0;
    for (const item of list) {
      if (typeof item !== 'string') continue;
      const word = item.trim().toLowerCase();
      if (!/^[a-z]+$/.test(word)) continue;
      if (set.has(word)) continue;
      set.add(word);
      added += 1;
    }
    console.log(`  · 常用词表 ${path.relative(ROOT, target)}：新增 ${added} 条`);
  }
  return set;
}

/**
 * 按标点切分，但忽略括号内部的标点。
 * 「在（船、飞机、火车等）上」不能被逗号切开。
 */
function splitOutsideBrackets(text, separators) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if ('（(【['.includes(char)) depth += 1;
    else if ('）)】]'.includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && separators.includes(char)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * 括号的处理规则（按括号在句中的位置区分）：
 * - 开头：多是词性补充，整组丢掉（"（使）加快" → "加快"）；
 * - 结尾：多是补充说明，丢掉更干净（"取消（计划好的事情）" → "取消"）；
 * - 中间：是限定语，必须保留内容，否则会留下残句
 *   （"在（船、飞机、火车等）上" → "在船、飞机、火车等上"，"使（某人）熟悉" → "使某人熟悉"）。
 */
function unwrapParentheticals(text) {
  const tokens = [];
  let depth = 0;
  let buffer = '';
  let current = '';

  for (const char of text) {
    if ('（(【['.includes(char)) {
      if (depth === 0) {
        if (current !== '') {
          tokens.push({ type: 'text', value: current });
          current = '';
        }
        buffer = '';
      }
      depth += 1;
      continue;
    }
    if ('）)】]'.includes(char)) {
      if (depth > 0) depth -= 1;
      if (depth === 0) {
        tokens.push({ type: 'group', value: buffer });
        buffer = '';
      }
      continue;
    }
    if (depth > 0) buffer += char;
    else current += char;
  }
  if (current !== '') tokens.push({ type: 'text', value: current });
  if (buffer !== '') tokens.push({ type: 'group', value: buffer });

  let result = '';
  tokens.forEach((token, index) => {
    if (token.type === 'text') {
      result += token.value;
      return;
    }
    const hasTextBefore = result !== '';
    const hasTextAfter = tokens
      .slice(index + 1)
      .some((next) => next.type === 'text' && next.value.trim() !== '');
    if (hasTextBefore && hasTextAfter) result += token.value;
  });
  return result;
}

/** 把完整词典释义压成一句短释义；压不出来就返回 null。 */
export function condenseGloss(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFKC')
    // <美> / <正式> 这类语域标注，以及 【名】 这类标注，对阅读没有价值
    .replace(/<[^>]*>/g, '')
    .replace(/[[【][^\]】]*[\]】]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return null;

  // 第一个义项 → 第一小句（括号内的逗号不算分隔）
  const senses = splitOutsideBrackets(cleaned, '；;');
  const head = senses[0] ?? '';
  const clauses = splitOutsideBrackets(head, '，,');
  const chosen = clauses[0] ?? head;

  const text = unwrapParentheticals(chosen)
    // 去掉残留的词性前缀与所有非中文噪声（保留中文顿号，读起来更清楚）
    .replace(/^[a-zA-Z.]+\s*/, '')
    .replace(/[^\u4e00-\u9fff、]/g, '')
    .trim();

  if (text === '') return null;
  const chars = [...text];
  return chars.length > MAX_GLOSS_CHARS ? chars.slice(0, MAX_GLOSS_CHARS).join('') : text;
}

function normalizePos(raw) {
  if (typeof raw !== 'string') return 'n.';
  const key = raw.trim().toLowerCase();
  if (key === '') return 'n.';
  const mapped = POS_MAP[key];
  if (mapped) return mapped;
  if (key.length <= 5 && /^[a-z.]+$/.test(key)) return key;
  return 'n.';
}

async function main() {
  // 参数解析放在 main 里：这样 import 本模块（测试纯函数）不会触发 process.exit
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const commonFlags = args.filter((arg) => arg.startsWith('--common='));
  const [sourceFile, level, outFile] = positional;

  if (!sourceFile || !level || !outFile) {
    console.error(USAGE);
    process.exit(1);
  }

  const payload = JSON.parse(await readFile(sourceFile, 'utf8'));
  const list = Array.isArray(payload) ? payload : (payload.words ?? payload.list ?? []);
  if (list.length === 0) {
    console.error('✗ 源文件里没找到词条数组');
    process.exit(1);
  }

  const commonWords = commonFlags.length > 0
    ? await loadCommonWords(commonFlags.map((flag) => flag.slice('--common='.length)))
    : new Set();
  if (commonWords.size > 0) {
    console.log(`常用词表合计 ${commonWords.size} 条：命中者标为 ${BASIC_LEVEL}（默认不标注）`);
  }

  const stats = {
    total: list.length,
    kept: 0,
    noTrans: 0,
    noGloss: 0,
    badWord: 0,
    truncated: 0,
    longSource: 0,
    basic: 0,
    target: 0,
  };
  const byWord = new Map();
  const duplicates = [];

  for (const item of list) {
    const rawWord = typeof item?.word === 'string' ? item.word : '';
    const word = rawWord.trim().toLowerCase();
    // 分词器按连字符/空格切词，带这些字符的条目永远匹配不到，直接丢弃
    if (!/^[a-z]+$/.test(word)) {
      stats.badWord += 1;
      continue;
    }

    const trans = Array.isArray(item.trans) ? item.trans : [];
    const usable = trans.filter((entry) => typeof entry?.cn === 'string' && entry.cn.trim() !== '');
    if (usable.length === 0) {
      stats.noTrans += 1;
      continue;
    }
    // 优先带词性的义项，其次第一条
    const primary = usable.find((entry) => typeof entry.pos === 'string' && entry.pos.trim() !== '') ?? usable[0];
    const sourceLength = [...String(primary.cn)].length;
    if (sourceLength > 40) stats.longSource += 1;
    const gloss = condenseGloss(primary.cn);
    if (gloss === null) {
      stats.noGloss += 1;
      continue;
    }
    if (sourceLength > MAX_GLOSS_CHARS) stats.truncated += 1;

    // 常用词表里的词归到 basic 档：默认不标注，避免整页都是中文
    const assignedLevel = commonWords.has(word) ? BASIC_LEVEL : level;
    if (assignedLevel === BASIC_LEVEL) stats.basic += 1;
    else stats.target += 1;

    const entry = { word, pos: normalizePos(primary.pos), gloss, level: assignedLevel };
    if (byWord.has(word)) {
      duplicates.push(word);
      continue;
    }
    byWord.set(word, entry);
  }

  const entries = [...byWord.values()].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
  stats.kept = entries.length;

  const target = path.isAbsolute(outFile) ? outFile : path.join(ROOT, outFile);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(entries, null, 0)}\n`, 'utf8');

  console.log(`✓ 导入 ${stats.kept} 条 → ${path.relative(ROOT, target)}`);
  console.log(`  源文件 ${stats.total} 条：丢弃非纯字母词 ${stats.badWord}、无释义 ${stats.noTrans + stats.noGloss}、源内重复 ${duplicates.length}`);
  console.log(`  其中 ${stats.truncated} 条由完整释义压缩而来（源释义 >40 字的有 ${stats.longSource} 条）`);
  console.log(`  难度划分：${level} ${stats.target} 条 / ${BASIC_LEVEL}（常用词，默认不标注） ${stats.basic} 条`);
  const posCount = {};
  for (const entry of entries) posCount[entry.pos] = (posCount[entry.pos] ?? 0) + 1;
  console.log(`  词性分布：${Object.entries(posCount).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}${c}`).join(' ')}`);
  console.log('  抽样：');
  for (const entry of entries.slice(0, 12)) {
    console.log(`    ${entry.word.padEnd(14)} ${entry.pos.padEnd(6)} ${entry.gloss}`);
  }
  console.log(`  抽尾：`);
  for (const entry of entries.slice(-6)) {
    console.log(`    ${entry.word.padEnd(14)} ${entry.pos.padEnd(6)} ${entry.gloss}`);
  }
}

// 只有直接运行时才执行导入；被测试 import 时只导出纯函数。
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
