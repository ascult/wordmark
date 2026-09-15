/**
 * 原型：交叉校验 teacher 的挑选质量。
 *
 * 【原型代码，不是生产实现】
 *
 * 蒸馏的前提是「teacher 挑得对」，但这一条不能只靠自证。这里用**独立裁判**来查：
 *
 *   1. 让 teacher 把句子翻成中文（关掉思考；9B 的译文比 1.5B 可靠得多）
 *   2. 让 teacher 挑义项
 *   3. 用**纯方法**（词典义 → 译文里定位）算出「哪些义项确实出现在译文里」
 *   4. 看 teacher 挑的那个义项是否落在方法定位到的集合里
 *
 * 方法定位是构造保证的硬证据：它只认译文里真实出现的字。
 * 当方法能定位到唯一义项、而 teacher 挑了别的，那就是 teacher 错了——
 * 这类个案会连译文一起打出来给人看。
 *
 * 用法：npm run proto:crosscheck -- --limit=30
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatClient } from './openai.mjs';
import { matchCandidate } from './match.mjs';
import { candidateWords, splitSentences } from './mt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : fallback;
};
const LIMIT = Number(flag('limit', 30));
const MAX_SENSES = Number(flag('max-senses', 5));
const KEY = (await readFile(flag('api-key-file', path.join(ROOT, '.tmp-probe', 'teacher-key')), 'utf8')).trim();
const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };
const SYSTEM = '你是英语词典编辑助手。只输出要求的答案，不解释。';

const client = new ChatClient({
  baseUrl: flag('base-url', 'http://127.0.0.1:8000'),
  apiKey: KEY,
  model: flag('model', 'mlx-community--Qwen3.5-9B-MLX-4bit'),
  extraBody: NO_THINK,
});

/** 义项里是否有片段出现在译文里。 */
function localize(sense, translation) {
  let best = null;
  for (const atom of sense.split('/')) {
    const hit = matchCandidate(atom, translation, { minLcs: 2 });
    if (hit && hit.score >= 0.5 && (best === null || hit.score > best.score)) best = hit;
  }
  return best;
}

async function main() {
  const sensesTable = JSON.parse(await readFile(path.join(ROOT, 'data', 'senses', 'cet4.json'), 'utf8'));
  const html = await readFile(path.join(ROOT, '.tmp-articles', 'https_paulgraham_com_greatwork_html.html'), 'utf8');
  const sentences = splitSentences(
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' '),
  );

  // 组样本：每句最多 2 个多义词
  const items = [];
  const seen = new Set();
  for (const sentence of sentences) {
    if (items.length >= LIMIT) break;
    const words = candidateWords(sentence).filter((word) => {
      const senses = sensesTable[word];
      return senses && senses.length >= 2 && senses.length <= MAX_SENSES;
    });
    for (const word of words.slice(0, 2)) {
      if (seen.has(word)) continue;
      seen.add(word);
      items.push({ sentence, word, senses: sensesTable[word] });
      if (items.length >= LIMIT) break;
    }
  }
  console.log(`样本 ${items.length} 个（每句最多 1 个新词，保证词不重复）\n`);

  const tally = { total: 0, methodLocalized: 0, teacherAgrees: 0, teacherDisagrees: 0, teacherOutOfSet: 0, teacherInvalid: 0 };
  const disagreements = [];

  for (const [index, item] of items.entries()) {
    // 1) 先让 teacher 翻译（关思考）
    const translateUser = `把下面这句英文翻成中文，只输出译文：\n${item.sentence}`;
    let translation = '';
    try {
      translation = (await client.complete({ system: SYSTEM, user: translateUser, maxTokens: 220 })).text.trim();
    } catch (error) {
      console.log(`[${index + 1}] 翻译失败：${error.message.slice(0, 60)}`);
      continue;
    }

    // 2) 让 teacher 挑义项
    const pickUser = [
      `句子：${item.sentence}`,
      `单词：${item.word}`,
      `义项：${item.senses.map((s, i) => `${i + 1})${s}`).join(' ')}`,
      '',
      '这个单词在这句话里是第几个义项？只输出一个数字。',
    ].join('\n');
    let choice;
    try {
      const raw = (await client.complete({ system: SYSTEM, user: pickUser, maxTokens: 16 })).text.trim();
      const match = raw.match(/\d+/);
      choice = match ? Number(match[0]) : 0;
    } catch {
      choice = 0;
    }

    // 3) 方法：哪些义项确实出现在译文里
    const localized = item.senses
      .map((sense, position) => ({ position, hit: localize(sense, translation) }))
      .filter((entry) => entry.hit !== null);

    tally.total += 1;
    if (!Number.isInteger(choice) || choice < 1 || choice > item.senses.length) {
      tally.teacherInvalid += 1;
      console.log(`[${index + 1}] ${item.word}：teacher 没给出有效序号（原始输出无法解析）`);
      continue;
    }
    const picked = choice - 1;
    if (localized.length === 0) {
      // 方法定位不到：无法裁判，只做记录
      console.log(`[${index + 1}] ${item.word} → teacher「${item.senses[picked]}」｜方法定位不到（译文：${translation.slice(0, 40)}）`);
      continue;
    }
    tally.methodLocalized += 1;
    const inSet = localized.some((entry) => entry.position === picked);
    if (inSet) {
      tally.teacherAgrees += 1;
      console.log(`[${index + 1}] ${item.word} → teacher「${item.senses[picked]}」✓ 与方法定位一致`);
    } else {
      tally.teacherDisagrees += 1;
      disagreements.push({ ...item, picked, translation, localized });
      console.log(
        `[${index + 1}] ${item.word} → teacher「${item.senses[picked]}」✗ 方法定位到的是「${localized.map((entry) => item.senses[entry.position]).join(' / ')}」`,
      );
    }
  }

  console.log(`\n${'='.repeat(90)}`);
  console.log(`共 ${tally.total} 个样本；teacher 无效输出 ${tally.teacherInvalid} 个`);
  console.log(`方法能定位的 ${tally.methodLocalized} 个里：teacher 一致 ${tally.teacherAgrees}，不一致 ${tally.teacherDisagrees}`);
  if (tally.methodLocalized > 0) {
    console.log(`→ 以方法为裁判，teacher 的一致率 ${((tally.teacherAgrees / tally.methodLocalized) * 100).toFixed(0)}%`);
  }
  console.log(`teacher 调用 ${client.stats.calls} 次，平均 ${client.stats.avgMs}ms`);

  if (disagreements.length > 0) {
    console.log(`\n不一致个案（译文 + teacher 的选择 + 方法定位）：`);
    for (const item of disagreements.slice(0, 8)) {
      console.log(`\n  ${item.word} 句子：${item.sentence.slice(0, 100)}`);
      console.log(`  译文：${item.translation.slice(0, 100)}`);
      console.log(`  teacher：${item.senses[item.picked]}`);
      console.log(`  方法：${item.localized.map((entry) => item.senses[entry.position]).join(' / ')}`);
    }
  }
}

await main();
