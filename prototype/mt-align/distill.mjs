/**
 * 原型：用大模型（teacher）蒸馏出「义项先验」，让扩展在**不跑任何模型**的情况下也能给出语境义。
 *
 * 【原型代码，不是生产实现】
 *
 * 蒸馏什么：对每个多义词，让 teacher 在真实句子里反复做「义项选择题」，
 * 统计各义项被选中的次数 → 得到一个按真实用法排序的义项表。
 *
 * 为什么这个产物能落地：它是一张静态表（词 → 义项排序），可以直接打进扩展。
 * 现在扩展只能盲用上游词典的「第一个义项」，而那个顺序是词典编者的顺序，
 * 不是真实阅读中的使用频率顺序。
 *
 * 怎么验证收益：对每个词留出一个观察做测试，用其余观察排序，然后比较
 *   - 基线：上游词典的第一个义项
 *   - 蒸馏：按 teacher 计数排序后的第一个义项
 * 哪个更常命中 teacher 在被留出的那个句子上的选择。
 *
 * 用法（本机 teacher，命令里不要带代理变量）：
 *   npm run proto:distill -- --batch=12 --limit=240
 *   key 可来自 --api-key= / 环境变量 OPENAI_API_KEY / .tmp-probe/teacher-key 文件
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatClient } from './openai.mjs';
import { candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const BASE_URL = flag('base-url', 'http://127.0.0.1:8000');
// key 的取法优先级：--api-key > 环境变量 > 本机文件（避免把密钥贴进对话记录）
const KEY_FILE = flag('api-key-file', path.join(ROOT, '.tmp-probe', 'teacher-key'));
const MODEL = flag('model', '');
const BATCH = Number(flag('batch', 12));
const LIMIT = Number(flag('limit', 240));
const MAX_SENSES = Number(flag('max-senses', 5));
const OUT = flag('out', path.join(ROOT, 'prototype', 'mt-align', 'distilled-senses.json'));
const MAX_CHARS_PER_CALL = Number(flag('max-chars', 6000));

const SYSTEM = [
  '你是英语词典编辑助手。你只输出「编号=序号」这样的行，不解释、不写别的。',
].join('');

async function loadCorpus() {
  const dir = path.join(ROOT, '.tmp-articles');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.html'));
  const sentences = [];
  for (const file of files) {
    const html = await readFile(path.join(dir, file), 'utf8');
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, ' ');
    sentences.push(...splitSentences(text));
  }
  return sentences;
}

function buildPrompt(items) {
  const lines = [
    '下面是若干「英文句子 + 一个单词 + 该词的候选义项」。',
    '请判断每个单词在它那句话里是哪个义项，只写序号。',
    '',
  ];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. 句子：${item.sentence}`);
    lines.push(`   单词：${item.word}`);
    lines.push(`   义项：${item.senses.map((sense, position) => `${position + 1})${sense}`).join(' ')}`);
  });
  lines.push('', '输出格式：每行「编号=序号」，例如 1=2。不要输出任何其他内容。', '', '输出：');
  return lines.join('\n');
}

function parsePicks(raw, count) {
  const picks = new Map();
  for (const line of String(raw).split('\n')) {
    const match = line.match(/(\d+)\s*[=:：]\s*(\d+)/);
    if (!match) continue;
    const index = Number(match[1]);
    const choice = Number(match[2]);
    if (index >= 1 && index <= count) picks.set(index, choice);
  }
  return picks;
}

function key(word, sentence) {
  return createHash('sha1').update(`${word}\u0000${sentence}`).digest('hex').slice(0, 12);
}

async function resolveApiKey() {
  const fromFlag = flag('api-key', '');
  if (fromFlag !== '') return fromFlag;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    return (await readFile(KEY_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

async function main() {
  const API_KEY = await resolveApiKey();
  if (API_KEY === '') {
    console.error(`缺少 key。三种给法任选：--api-key=xxx / 环境变量 OPENAI_API_KEY / 写进 ${path.relative(ROOT, KEY_FILE)}`);
    process.exit(1);
  }
  const sensesTable = JSON.parse(await readFile(path.join(ROOT, 'data', 'senses', 'cet4.json'), 'utf8'));

  // 先问服务端要模型 id（用户只说「qwen3.5 9b」，真实 id 以服务端为准）
  const probe = new ChatClient({ baseUrl: BASE_URL, apiKey: API_KEY, model: 'probe' });
  const models = await probe.listModels().catch((error) => {
    console.log(`无法列出模型（${error.message}），沿用 --model 或 default`);
    return [];
  });
  if (models.length > 0) console.log(`服务端可用模型：${models.join(', ')}`);
  const modelId = MODEL || models[0] || 'default';
  const client = new ChatClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    model: modelId,
    // 关掉推理模型的思考过程，否则 token 全被前言吃掉、答案是空的
    extraBody: { chat_template_kwargs: { enable_thinking: false } },
  });
  console.log(`teacher：${modelId} @ ${BASE_URL}\n`);

  const sentences = await loadCorpus();
  const items = [];
  const seen = new Set();
  for (const sentence of sentences) {
    if (items.length >= LIMIT) break;
    const words = candidateWords(sentence).filter((word) => sensesTable[word]?.length >= 2 && sensesTable[word].length <= MAX_SENSES);
    for (const word of words.slice(0, 2)) {
      const id = key(word, sentence);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ id, word, sentence, senses: sensesTable[word] });
      if (items.length >= LIMIT) break;
    }
  }
  console.log(`语料：${sentences.length} 句 → ${items.length} 个「词 × 句」待判断\n`);

  // 按字符预算分批
  const batches = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const cost = item.sentence.length + item.senses.join('').length + 40;
    if (current.length > 0 && (size + cost > MAX_CHARS_PER_CALL || current.length >= BATCH)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += cost;
  }
  if (current.length > 0) batches.push(current);

  const observations = new Map(); // word → [chosenIndex…]
  let answered = 0;
  let invalid = 0;
  const startedAt = Date.now();

  for (const [index, batch] of batches.entries()) {
    let picks;
    try {
      const { text } = await client.complete({ system: SYSTEM, user: buildPrompt(batch), maxTokens: 64 + batch.length * 8 });
      if (index === 0) console.log(`  首批原始输出：${JSON.stringify(text.trim().slice(0, 120))}`);
      picks = parsePicks(text, batch.length);
    } catch (error) {
      console.log(`  批 ${index + 1} 失败：${error.message}`);
      continue;
    }
    for (const [position, choice] of picks) {
      const item = batch[position - 1];
      if (!item) continue;
      if (choice < 1 || choice > item.senses.length) {
        invalid += 1;
        continue;
      }
      answered += 1;
      const list = observations.get(item.word) ?? [];
      list.push({ choice: choice - 1, sentence: item.sentence, senses: item.senses });
      observations.set(item.word, list);
    }
    const done = index + 1;
    if (done % 5 === 0 || done === batches.length) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`  批 ${done}/${batches.length} 已作答 ${answered}/${items.length} 用时 ${elapsed}s`);
    }
  }

  // ---- 蒸馏：留一验证 + 生成义项先验 ----
  let heldOut = 0;
  let baselineHit = 0;
  let distilledHit = 0;
  const artifact = {};
  for (const [word, list] of observations) {
    if (list.length < 2) {
      artifact[word] = { senses: list[0].senses, counts: countOf(list), total: list.length, verified: false };
      continue;
    }
    // 留出最后一条做测试，其余用来排序
    const held = list[list.length - 1];
    const train = list.slice(0, -1);
    const counts = countOf(train);
    let top = 0;
    counts.forEach((value, position) => {
      if (value > (counts[top] ?? 0)) top = position;
    });
    heldOut += 1;
    if (held.choice === 0) baselineHit += 1;      // 基线＝永远选第一个义项
    if (held.choice === top) distilledHit += 1;    // 蒸馏＝选训练里最高频的义项
    artifact[word] = { senses: held.senses, counts: countOf(list), total: list.length, verified: true, top };
  }

  await writeFile(OUT, `${JSON.stringify(artifact, null, 0)}\n`, 'utf8');
  const words = Object.keys(artifact).length;
  console.log(`\n${'='.repeat(84)}`);
  console.log(`作答 ${answered}/${items.length}（无效序号 ${invalid}），涉及 ${words} 个词`);
  console.log(`teacher 调用 ${client.stats.calls} 次，平均 ${client.stats.avgMs}ms，最慢 ${client.stats.maxMs}ms`);
  if (heldOut > 0) {
    console.log(`\n留一验证（${heldOut} 个词有 ≥2 条观察）：`);
    console.log(`  基线（上游词典的第一个义项）命中 ${baselineHit}   ${((baselineHit / heldOut) * 100).toFixed(0)}%`);
    console.log(`  蒸馏（按真实用法排序的第一个义项）命中 ${distilledHit}   ${((distilledHit / heldOut) * 100).toFixed(0)}%`);
    console.log(`  差值 ${(((distilledHit - baselineHit) / heldOut) * 100).toFixed(1)} 个百分点`);
  }
  console.log(`\n产物 → ${path.relative(ROOT, OUT)}`);
}

function countOf(list) {
  const counts = [];
  for (const entry of list) counts[entry.choice] = (counts[entry.choice] ?? 0) + 1;
  for (let i = 0; i < counts.length; i += 1) counts[i] = counts[i] ?? 0;
  return counts;
}

await main();
