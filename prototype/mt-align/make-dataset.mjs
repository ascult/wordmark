/**
 * 生成「义项选择」任务的训练数据（供 LoRA 微调小模型）。
 *
 * 【原型代码，不是生产实现】
 *
 * 流程与设计要点：
 *   1. 从真实文章里抽「句子 × 多义词」样本，按词去重并限流（避免少数词刷屏）；
 *   2. **teacher 按义项原序判断** —— 原序对 9B 最自然，标签最干净；
 *   3. 训练/验证样本把义项**打乱**（用样本 id 做确定性种子），
 *      目标标签 = teacher 选中的那个义项在打乱后列表里的位置。
 *      这样小模型无法靠「位置先验」蒙（否则光是「总答第 1 个」就能拿高分），
 *      必须真的读句子才能选对。
 *   4. 输出 mlx-lm 认的 chat 格式 JSONL，外加一份审计用的 items.jsonl。
 *
 * 用法：
 *   node prototype/mt-align/make-dataset.mjs --limit=6000 --base-url=http://127.0.0.1:8081 --api-key=sk-teacher
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatClient } from './openai.mjs';
import { candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = path.join(ROOT, 'prototype', 'mt-align', 'dataset');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};

const LIMIT = Number(flag('limit', 6000));
const BATCH = Number(flag('batch', 20));
const MAX_SENSES = Number(flag('max-senses', 5));
const MIN_SENTENCE_CHARS = Number(flag('min-chars', 40));
const MAX_SENTENCE_CHARS = Number(flag('max-sentence-chars', 320));
const MIN_SENSES = Number(flag('min-senses', 2));
const PER_WORD_CAP = Number(flag('per-word', 8));
const PER_SENTENCE = Number(flag('per-sentence', 2));
/** 每次请求的字符预算：llama-server 的上下文是 4096 token，太长会直接 HTTP 400。 */
const MAX_CHARS_PER_CALL = Number(flag('max-chars', 2600));
/** 把上一句也写进查询：验证「消歧需要上下文」这个假设（v1 坏数据反而更好的线索）。 */
const WITH_PREV = args.includes('--prev-sentence');
const VAL_RATIO = Number(flag('val-ratio', 0.15));
const OUT_DIR = flag('out', DEFAULT_OUT);
const BASE_URL = flag('base-url', 'http://127.0.0.1:8000');
const MODEL = flag('model', 'q');
const KEY_FILE = flag('api-key-file', path.join(ROOT, '.tmp-probe', 'teacher-key'));

const SYSTEM = '你是英语词典编辑助手。你只输出「编号=序号」这样的行，不解释、不写别的。';

function hash(text) {
  return createHash('sha1').update(text).digest('hex');
}

/** 用样本 id 做种子的确定性洗牌（可复现，且训练/验证都公平）。 */
function shuffleWithSeed(list, seed) {
  const items = [...list];
  let state = Number.parseInt(seed.slice(0, 8), 16) || 1;
  for (let i = items.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

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
      .replace(/&mdash;/g, '—')
      .replace(/&#39;|&rsquo;/g, "'")
      .replace(/\s+/g, ' ');
    sentences.push(...splitSentences(text));
  }
  return sentences;
}

function buildPrompt(items) {
  const lines = ['下面是若干「英文句子 + 一个单词 + 该词的候选义项」。', '请判断每个单词在它那句话里是哪个义项，只写序号。', ''];
  items.forEach((item, index) => {
    if (item.context) lines.push(`   （上一句：${item.context}）`);
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

async function main() {
  const apiKey = flag('api-key', '') || (await readFile(KEY_FILE, 'utf8').catch(() => '')).trim();
  if (apiKey === '') {
    console.error('缺少 key（--api-key 或 --api-key-file）');
    process.exit(1);
  }
  const sensesTable = JSON.parse(await readFile(path.join(ROOT, 'prototype', 'mt-align', 'senses.json'), 'utf8'));
  const client = new ChatClient({ baseUrl: BASE_URL, apiKey, model: MODEL });

  // === 1. 抽样本 ===
  const sentences = await loadCorpus();
  const perWord = new Map();
  const items = [];
  const seen = new Set();
  for (const [position, sentence] of sentences.entries()) {
    // 同一篇文章内的上一句；跨文章边界（长度骤变）就不带，避免把不相干的句子当上下文
    const previous = WITH_PREV ? (sentences[position - 1] ?? '') : '';
    const context = previous !== '' && previous.length <= MAX_SENTENCE_CHARS ? previous : '';
    if (items.length >= LIMIT) break;
    if (sentence.length < MIN_SENTENCE_CHARS || sentence.length > MAX_SENTENCE_CHARS) continue;
    const words = candidateWords(sentence).filter((word) => {
      const senses = sensesTable[word];
      return senses && senses.length >= MIN_SENSES && senses.length <= MAX_SENSES;
    });
    let taken = 0;
    for (const word of words) {
      if (taken >= PER_SENTENCE || items.length >= LIMIT) break;
      const count = perWord.get(word) ?? 0;
      if (count >= PER_WORD_CAP) continue;
      const id = hash(`${word}\u0000${sentence}`).slice(0, 16);
      if (seen.has(id)) continue;
      seen.add(id);
      perWord.set(word, count + 1);
      items.push({ id, word, sentence, senses: sensesTable[word], context });
      taken += 1;
    }
  }
  console.log(`语料 ${sentences.length} 句 → 样本 ${items.length} 个，涉及 ${perWord.size} 个词`);

  // === 2. teacher 按原序判断 ===
  // 按「条数 + 字符预算」双重切分：长句批次照样会爆上下文
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
  console.log(`切成 ${batches.length} 批（每批 ≤${BATCH} 条 / ≤${MAX_CHARS_PER_CALL} 字符）`);
  const labels = new Map();
  const startedAt = Date.now();
  for (const [index, batch] of batches.entries()) {
    try {
      const { text } = await client.complete({ system: SYSTEM, user: buildPrompt(batch), maxTokens: 64 + batch.length * 8 });
      for (const [position, choice] of parsePicks(text, batch.length)) {
        const item = batch[position - 1];
        if (item && choice >= 1 && choice <= item.senses.length) labels.set(item.id, choice - 1);
      }
    } catch (error) {
      console.log(`  批 ${index + 1} 失败：${error.message.slice(0, 70)}`);
    }
    if ((index + 1) % 25 === 0 || index + 1 === batches.length) {
      console.log(`  批 ${index + 1}/${batches.length} 标注 ${labels.size}/${items.length} ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    }
  }

  // === 3. 打乱义项 + 切分 ===
  const samples = [];
  for (const item of items) {
    const picked = labels.get(item.id);
    if (picked === undefined) continue;
    const chosen = item.senses[picked];
    const shuffled = shuffleWithSeed(item.senses, item.id);
    const target = shuffled.indexOf(chosen);
    if (target < 0) continue;
    const user = [
      ...(item.context ? [`上一句：${item.context}`] : []),
      `句子：${item.sentence}`,
      `单词：${item.word}`,
      `义项：${shuffled.map((sense, position) => `${position + 1})${sense}`).join(' ')}`,
      '',
      '这个单词在这句话里是第几个义项？只输出一个数字。',
    ].join('\n');
    samples.push({
      id: item.id,
      word: item.word,
      sentence: item.sentence,
      // 必须把 context 一起存下来：训练脚本读的是 item.context，
      // 只写进 prompt 而不落盘的话，v3 训练时等于没带上下文（踩过）
      context: item.context ?? '',
      originalSenses: item.senses,
      originalPicked: picked,
      shuffledSenses: shuffled,
      target: target + 1,
      user,
      isVal: (Number.parseInt(item.id.slice(0, 6), 16) % 1000) / 1000 < VAL_RATIO,
    });
  }

  const train = samples.filter((sample) => !sample.isVal);
  const valid = samples.filter((sample) => sample.isVal);
  const toChat = (sample) => JSON.stringify({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: sample.user },
      { role: 'assistant', content: String(sample.target) },
    ],
  });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(path.join(OUT_DIR, 'train.jsonl'), `${train.map(toChat).join('\n')}\n`, 'utf8');
  await writeFile(path.join(OUT_DIR, 'valid.jsonl'), `${valid.map(toChat).join('\n')}\n`, 'utf8');
  await writeFile(path.join(OUT_DIR, 'items.jsonl'), `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`, 'utf8');

  // === 4. 体检 ===
  const positionCounts = [];
  const senseCounts = [];
  for (const sample of samples) {
    positionCounts[sample.originalPicked] = (positionCounts[sample.originalPicked] ?? 0) + 1;
    senseCounts[sample.senses?.length ?? sample.originalSenses.length] = (senseCounts[sample.originalSenses.length] ?? 0) + 1;
  }
  const total = samples.length;
  console.log(`\n可用样本 ${total}（train ${train.length} / valid ${valid.length}）`);
  console.log(`teacher 选中位置分布（原序）：${positionCounts.map((n, i) => `${i + 1}:${((n / total) * 100).toFixed(0)}%`).join('  ')}`);
  console.log(`义项个数分布：${senseCounts.map((n, i) => (n ? `${i}个:${n}` : null)).filter(Boolean).join('  ')}`);
  console.log(`随机基线（打乱后按义项数猜）= ${(samples.reduce((sum, s) => sum + 1 / s.originalSenses.length, 0) / total * 100).toFixed(1)}%`);
  console.log(`产物 → ${path.relative(ROOT, OUT_DIR)}/train.jsonl, valid.jsonl, items.jsonl`);
}

await main();
