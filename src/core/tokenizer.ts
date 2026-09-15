/**
 * 英文分词器。
 *
 * 只处理 ASCII 字母与「词内撇号」，因为其余字符（数字、CJK、
 * 标点）都不应该被标注。分词结果保留原文偏移量，方便按需回填。
 */

export interface Token {
  /** 原始文本片段。 */
  text: string;
  /** 在源字符串中的起始下标。 */
  start: number;
  /** 在源字符串中的结束下标（不含）。 */
  end: number;
}

/**
 * 词内允许撇号（' 或 ’），用于 don't / it's / reader's 这类形式。
 * 连字符刻意不纳入：well-known 会被拆成 well 与 known 两个独立词。
 */
const WORD_RE = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

/** 切分文本为词元列表。 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // 每次调用重置 lastIndex 是必需的：正则带 g 标志且有状态。
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    const raw = match[0];
    tokens.push({ text: raw, start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

/** 判断一个 token 是否值得送去查词。 */
export function isCandidateToken(
  token: string,
  options: { minWordLength: number },
): boolean {
  const letters = token.replace(/['\u2019]/g, '');
  if (letters.length < options.minWordLength) return false;
  // 纯大写通常是人名缩写 / 术语缩写（HTTP、NASA、OK），标注会变成噪音。
  if (letters.length >= 2 && letters === letters.toUpperCase()) return false;
  // camelCase / 驼峰标识符多半是代码或品牌名。
  if (/[a-z][A-Z]/.test(token)) return false;
  return true;
}

/** 归一化词形：统一撇号、转小写。 */
export function normalizeToken(token: string): string {
  return token.replace(/\u2019/g, "'").toLowerCase();
}

/** 去掉所有格与常见缩写后缀，返回词干候选。 */
export function stripClitics(normalized: string): string {
  if (normalized.includes("'")) {
    const head = normalized.slice(0, normalized.indexOf("'"));
    if (head.length > 0) return head;
  }
  return normalized;
}
