/**
 * 原型：机器翻译客户端（带批量与缓存）。
 *
 * 【这是原型代码，不是生产实现】——它只回答一个问题：
 * 「整段机翻 + 把译文对齐回原词」这条路，请求数、限流、延迟撑不撑得住？
 *
 * 关键发现（决定了整个形状）：
 * - 谷歌免费接口（client=dict-chrome-ex）**支持 POST 且一次可翻整段**，
 *   响应里每段都带回配对的源文片段 → 句级对齐是白送的；
 * - 但该接口**限流极狠**（连续几个请求就 429），所以必须：
 *   批量（一段一请求）+ 磁盘缓存（同一句永不重复请求）+ 退避重试。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
/** 一次请求携带的最大字符数；POST 能承载更多，但太大容易被判滥用。 */
const MAX_CHARS_PER_REQUEST = 1800;

export class MachineTranslator {
  #cache = new Map();
  #cacheFile;
  #requests = 0;
  #cacheHits = 0;
  #retries = 0;

  constructor({ cacheFile }) {
    this.#cacheFile = cacheFile;
  }

  get stats() {
    return { requests: this.#requests, cacheHits: this.#cacheHits, retries: this.#retries };
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.#cacheFile, 'utf8'));
      for (const [key, value] of Object.entries(raw)) this.#cache.set(key, value);
      return this.#cache.size;
    } catch {
      return 0;
    }
  }

  async save() {
    await mkdir(path.dirname(this.#cacheFile), { recursive: true });
    await writeFile(this.#cacheFile, JSON.stringify(Object.fromEntries(this.#cache)), 'utf8');
  }

  /** 翻译一批段落，返回「句子 → 译文」的映射（含配对好的源文片段）。 */
  async translateParagraphs(paragraphs) {
    const pairs = new Map();
    const pending = [];

    for (const paragraph of paragraphs) {
      const key = hash(paragraph);
      const cached = this.#cache.get(key);
      if (cached) {
        this.#cacheHits += 1;
        for (const pair of cached) pairs.set(pair.source.trim(), pair.target);
        continue;
      }
      pending.push({ key, paragraph });
    }

    for (const chunk of chunkByLength(pending, MAX_CHARS_PER_REQUEST)) {
      const joined = chunk.map((item) => item.paragraph).join('\n');
      const segments = await this.#request(joined);
      // 把返回的段落重新分配给各个输入段落：按源文片段顺序切
      const allPairs = segments.map((seg) => ({ source: seg[1] ?? '', target: seg[0] ?? '' }));
      for (const item of chunk) {
        const own = allPairs.filter((pair) => item.paragraph.includes(pair.source.trim()));
        if (own.length > 0) this.#cache.set(item.key, own);
        for (const pair of (own.length > 0 ? own : allPairs)) {
          pairs.set(pair.source.trim(), pair.target);
        }
      }
    }
    return pairs;
  }

  async #request(text, attempt = 1) {
    const body = new URLSearchParams({ client: 'dict-chrome-ex', sl: 'en', tl: 'zh-CN', q: text });
    body.append('dt', 't');
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (attempt <= 3) {
        this.#retries += 1;
        await sleep(1500 * attempt);
        return this.#request(text, attempt + 1);
      }
      throw new Error(`翻译请求失败：${error.message}`, { cause: error });
    }

    this.#requests += 1;
    if (response.status === 429 && attempt <= 4) {
      // 限流是这条路的头号风险，退避重试并记账
      this.#retries += 1;
      await sleep(4000 * attempt);
      return this.#request(text, attempt + 1);
    }
    if (!response.ok) throw new Error(`翻译失败 HTTP ${response.status}`);
    const data = await response.json();
    return (data[0] ?? []).filter((seg) => typeof seg?.[0] === 'string');
  }
}

function hash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

function chunkByLength(items, maxChars) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const item of items) {
    const size = item.paragraph.length + 1;
    if (current.length > 0 && length + size > maxChars) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 把正文切成句子。
 *
 * 踩过的坑（都会污染训练数据，也会让机翻/对齐按错误的单位做）：
 *   1. 引号结尾的句子切不开：`…young men.” “In what…` —— 因为句末标点后面跟着
 *      右引号，而按标点直接切会漏掉。这里改成「吞掉可选的右引号再切」。
 *   2. Gutenberg 的页码标记 `{307}` 和残留实体 `&#8217;` 会混进句子。
 *   3. 切不动的长句（对话连排）会把好几句话粘成一坨，最长见过 2190 字符——
 *      训练时是长文本块、线上却是单句，直接造成分布不一致。所以超过阈值
 *      就在最近的逗号/分号/破折号处再切一刀。
 */
const MAX_SENTENCE_CHARS = 320;

function tidySentenceText(text) {
  return text
    .replace(/&[a-zA-Z]+;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\{\s?\d+\s?\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hardWrap(sentence) {
  if (sentence.length <= MAX_SENTENCE_CHARS) return [sentence];
  const pieces = [];
  let rest = sentence;
  while (rest.length > MAX_SENTENCE_CHARS) {
    const window = rest.slice(0, MAX_SENTENCE_CHARS);
    // 从后往前找最近的切点；找不到就硬切
    let cut = Math.max(
      window.lastIndexOf('，'),
      window.lastIndexOf('；'),
      window.lastIndexOf('—'),
      window.lastIndexOf(', '),
      window.lastIndexOf('; '),
    );
    if (cut < MAX_SENTENCE_CHARS * 0.5) cut = MAX_SENTENCE_CHARS - 1;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

export function splitSentences(text) {
  const cleaned = tidySentenceText(text);
  const boundary = /([.!?]["'\u201d\u2019)\]]?)\s+(?=[A-Z"\u201c'(])/g;
  const parts = [];
  let last = 0;
  let match;
  while ((match = boundary.exec(cleaned)) !== null) {
    parts.push(cleaned.slice(last, match.index + match[1].length));
    last = match.index + match[1].length;
  }
  parts.push(cleaned.slice(last));

  const sentences = [];
  for (const part of parts) {
    for (const piece of hardWrap(part.trim())) {
      if (piece.length >= 24 && /[A-Za-z]/.test(piece)) sentences.push(piece);
    }
  }
  return sentences;
}

const MIN_WORD_LENGTH = 4;
export function candidateWords(sentence) {
  const words = sentence.match(/[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g) ?? [];
  const out = [];
  for (const raw of words) {
    const letters = raw.replace(/['\u2019]/g, '');
    if (letters.length < MIN_WORD_LENGTH) continue;
    if (letters === letters.toUpperCase()) continue;
    if (/[a-z][A-Z]/.test(raw)) continue;
    out.push(raw.toLowerCase());
  }
  return [...new Set(out)];
}

export { path };
