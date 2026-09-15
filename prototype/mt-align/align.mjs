/**
 * 原型：三种「把译文对齐回原词」的策略。
 *
 * 【原型代码，不是生产实现】
 *
 * S1 词表 ∩ 译文子串   —— 零模型、零额外请求：拿现有词表的释义，去整句译文里找。
 *                          只能覆盖词表内的词，但能回答「这个词的释义和机翻一致吗」。
 * S2 机翻 + 小模型对齐 —— 把（原句、整句机翻、候选词）交给小模型，要求它**只能在译文的字里选**。
 *                          这是用户设想的路线：从译文里识别出原词对应的部分。
 * S3 小模型端到端      —— 不给译文，直接「翻译 + 逐词释义」。
 *                          用来回答：多那一趟机翻到底值不值。
 *
 * 客观指标（能自动算的）：
 *   - 一致率：模型给的释义是否为整句译文的子串（用户要的「与译文一致」的代理）
 *   - 合法率：输出能否解析成预期 JSON
 *   - 覆盖率：候选词里有多少拿到了释义
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* S1：用现有词表的释义去译文里找                                      */
/* ------------------------------------------------------------------ */

/**
 * 词表的释义偶尔带顿号（"船、飞机…"）或多义，这里做宽松匹配：
 * 整条命中，或释义里的任一「义项片段」命中译文。
 */
export function alignWithDictionary(translation, words, dictionary) {
  const results = new Map();
  for (const word of words) {
    const entry = dictionary.get(word);
    if (!entry) continue;
    const parts = entry.gloss.split(/[、，,]/).filter((part) => part.length >= 2);
    const hit = [entry.gloss, ...parts].find((candidate) => translation.includes(candidate));
    if (hit) results.set(word, { gloss: hit, level: entry.level, inTranslation: true });
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* 小模型批量执行器                                                     */
/* ------------------------------------------------------------------ */

export class LocalLlm {
  #child;
  #pending = new Map();
  #buffer = '';
  #nextId = 1;
  #latencies = [];

  constructor({ model, maxTokens = 512, pythonPath, hfHome, proxy } = {}) {
    this.model = model ?? 'mlx-community/Qwen2.5-1.5B-Instruct-4bit';
    this.maxTokens = maxTokens;
    this.pythonPath = pythonPath ?? path.join(HERE, '..', '..', '.tmp-probe', 'venv', 'bin', 'python');
    this.env = {
      ...process.env,
      HF_HOME: hfHome ?? path.join(HERE, '..', '..', '.tmp-probe', 'hf'),
      // Xet 后端在这台机器上被墙：不关掉，任何缺失文件都会卡在 0 字节
      HF_HUB_DISABLE_XET: '1',
      ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
    };
  }

  start() {
    this.#child = spawn(this.pythonPath, [path.join(HERE, 'llm.py'), this.model, String(this.maxTokens)], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      if (/error|traceback/i.test(text)) process.stderr.write(`[llm] ${text}`);
    });
    return this;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index;
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === '') continue;
      try {
        const message = JSON.parse(line);
        const waiter = this.#pending.get(message.id);
        if (waiter) {
          this.#pending.delete(message.id);
          this.#latencies.push(Date.now() - waiter.startedAt);
          waiter.resolve(message.raw);
        }
      } catch {
        // 原型：解析不了的输出直接忽略
      }
    }
  }

  get stats() {
    if (this.#latencies.length === 0) return { calls: 0, avgMs: 0 };
    const total = this.#latencies.reduce((sum, value) => sum + value, 0);
    return {
      calls: this.#latencies.length,
      avgMs: Math.round(total / this.#latencies.length),
      maxMs: Math.max(...this.#latencies),
    };
  }

  ask(system, user, { timeoutMs = 120_000 } = {}) {
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('小模型响应超时'));
      }, timeoutMs);
      this.#pending.set(id, {
        startedAt,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.#child.stdin.write(`${JSON.stringify({ id, system, user })}\n`);
    });
  }

  stop() {
    try {
      this.#child?.stdin.end();
      this.#child?.kill();
    } catch {
      // 忽略
    }
  }
}

/** 从模型输出里抠出第一个 JSON 对象（小模型常会加解释或代码块）。 */
export function parseJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* S2 / S3 的提示词                                                     */
/* ------------------------------------------------------------------ */

const SYSTEM = [
  '你是英语阅读助手。你只输出 JSON 对象，不输出解释、不加代码块围栏。',
  '你给出的中文释义必须简洁——2 到 6 个汉字。',
].join('');

/** S2：给了机翻，要求释义必须是译文里出现过的字词。 */
export function buildAlignedPrompt(sentence, translation, words) {
  return [
    '英文原句：',
    sentence,
    '',
    '这句话的中文机翻：',
    translation,
    '',
    `请为下面每个单词给出它在这句话里的中文释义：${words.join(', ')}`,
    '',
    '规则：',
    '1. 释义必须直接取自上面那句中文机翻——也就是译文里对应这个词的那部分字词。',
    '2. 只给这个词在本句里的意思，不要罗列其他义项。',
    '3. 如果某个词在这句译文里找不到对应部分，就把它写成空字符串。',
    '4. 只输出一个 JSON 对象，键是英文单词，值是中文释义。',
    '',
    'JSON：',
  ].join('\n');
}

/**
 * S3：不给译文，直接「翻译 + 逐词释义」。
 * 要求模型同时输出整句译文，这样「释义是不是译文的一部分」可以自动校验——
 * 对齐质量不再需要人眼判断，而是能被测量的自洽性。
 */
export function buildEndToEndPrompt(sentence, words) {
  return [
    '英文句子：',
    sentence,
    '',
    `请先把这句话翻成中文，再给下面每个单词写出它在这句话里的中文释义：${words.join(', ')}`,
    '',
    '规则：',
    '1. 释义用 2 到 6 个汉字，只给这个词在本句中的意思。',
    '2. 每个释义都必须是你在第一项里给出的那句译文的一部分（原样出现）。',
    '3. 只输出 JSON，形如：{"translation": "整句译文", "glosses": {"word": "释义"}}',
    '',
    'JSON：',
  ].join('\n');
}

/** 从 S3 的输出里同时取回译文与释义。 */
export function splitEndToEnd(parsed) {
  if (!parsed || typeof parsed !== 'object') return { translation: '', glosses: new Map() };
  const translation = typeof parsed.translation === 'string' ? parsed.translation.trim() : '';
  const glosses = new Map();
  const table = parsed.glosses ?? parsed;
  for (const [word, gloss] of Object.entries(table)) {
    if (word === 'translation') continue;
    if (typeof gloss === 'string' && gloss.trim() !== '') {
      glosses.set(word.toLowerCase(), { gloss: gloss.trim() });
    }
  }
  return { translation, glosses };
}

/**
 * S4：词典义 + 语境校正。
 *
 * 这是「匹配词典义和语境义」的直接实现：把词典给的释义作为**候选**交给模型，
 * 让它判断在这个句子里合不合适——合适就原样保留，不合适才改。
 *
 * 与 S3 的差别只有「有没有给词典义」这一处，所以两者对照就能隔离出
 * 词典到底贡献了多少（模型会不会自己收敛到词典义、词典答错的比例有多高）。
 */
export function buildRefinePrompt(sentence, wordGlosses) {
  return [
    '英文句子：',
    sentence,
    '',
    '下面这些词已经有词典释义，请判断它们在这句话里是否合适：',
    ...wordGlosses.map(([word, gloss]) => `${word}（词典义：${gloss}）`),
    '',
    '规则：',
    '1. 如果词典释义在这句话里就是对的，原样返回它，不要改动措辞。',
    '2. 如果在这句话里意思不对，改成贴合本句语境的释义，2 到 6 个汉字。',
    '3. 同时给出整句中文翻译。',
    '4. 只输出 JSON，形如：{"translation":"整句译文","glosses":{"词":"释义"}}',
    '',
    'JSON：',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把某一策略的结果与译文对照，产出可比较的指标。
 *
 * 分三档，因为「严格子串」会把正确的释义误判为失败：
 *   strict —— 释义原样出现在译文里（最强的对应证据）
 *   loose  —— 释义前两字出现在译文里（如 释义「不同的」对应译文里的「不同领域」）
 *   none   —— 两档都不中：该词在译文里没有对应表面，多半是虚词或在翻译中被省略
 */
export function score({ words, translation, results }) {
  // 只统计「我们问过、且模型给了释义」的词；模型多给的键不算进分子
  const answered = words.filter((word) => (results.get(word)?.gloss ?? '') !== '');
  let strict = 0;
  let loose = 0;
  let none = 0;
  for (const word of answered) {
    const gloss = results.get(word).gloss;
    const head = [...gloss].slice(0, 2).join('');
    if (translation.includes(gloss)) strict += 1;
    else if (head.length >= 2 && translation.includes(head)) loose += 1;
    else none += 1;
  }
  return {
    candidates: words.length,
    answered: answered.length,
    coverage: words.length === 0 ? 0 : answered.length / words.length,
    strict,
    loose,
    none,
    inTranslation: strict,
    aligned: answered.length === 0 ? 0 : strict / answered.length,
  };
}

export { SYSTEM };
