/**
 * 从一段文本里定位「某个词所在的句子」，返回**带偏移**的句子。
 *
 * 为什么需要它：语境义挑选要的是「这个词所在的句子」这个上下文。
 * 但 DOM 里的句子常常跨多个行内元素（`<b>`、`<a>`、`<em>`），
 * 单词所在的那个文本节点本身往往只有几个词——只把节点文本发出去，
 * 模型看到的是「fragment」而不是句子，效果会明显变差。
 *
 * 做法：取该文本节点最近的块级祖先的 `textContent`（= 整段），
 * 把词在段内的字符偏移算出来，再在段文本上切句、定位。
 *
 * 切句规则刻意与 `prototype/mt-align/mt.mjs` 的 `splitSentences` 对齐
 * （句末标点后可能有右引号 / 右括号，要先吞掉再切；换行也是硬边界），
 * 只是这里**必须保留偏移**——原型那版直接 trim 掉了偏移，够训练用，不够改 DOM 用。
 */

/** 送进打分的上下文上限：训练时句子被硬折到 320 字符，线上也应大致同一量级。 */
export const MAX_CONTEXT_CHARS = 320;

export interface SentenceSpan {
  /** 在原始文本中的起始偏移（含）。 */
  start: number;
  /** 在原始文本中的结束偏移（不含）。 */
  end: number;
  /** `text.slice(start, end)`，已去掉首尾空白。 */
  text: string;
}

/** 句末标点 + 可选的右引号/右括号，后面跟空白与一个大写/引号开头 → 是句子边界。 */
const BOUNDARY = /([.!?]["'\u201d\u2019)\]]?)\s+(?=[A-Z"\u201c'(])/g;

function pushSpan(text: string, spans: SentenceSpan[], from: number, to: number): void {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start] as string)) start += 1;
  while (end > start && /\s/.test(text[end - 1] as string)) end -= 1;
  if (end <= start) return;
  spans.push({ start, end, text: text.slice(start, end) });
}

/**
 * 切句并保留偏移。换行是硬边界（DOM 的 `textContent` 里 `<br>`/块级元素会留下换行）。
 */
export function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  // 先按换行分段，避免跨段拼接出一句假的句子
  const segments: Array<{ from: number; to: number }> = [];
  let segStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    const isBreak = index === text.length || text[index] === '\n';
    if (!isBreak) continue;
    if (index > segStart) segments.push({ from: segStart, to: index });
    segStart = index + 1;
  }

  for (const segment of segments) {
    const slice = text.slice(segment.from, segment.to);
    BOUNDARY.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = BOUNDARY.exec(slice)) !== null) {
      const end = match.index + (match[1] as string).length;
      pushSpan(text, spans, segment.from + cursor, segment.from + end);
      cursor = BOUNDARY.lastIndex;
    }
    pushSpan(text, spans, segment.from + cursor, segment.to);
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * 把过长的句子裁到 `maxChars` 以内，**尽量以目标词为中心**。
 *
 * 裁的时候优先在空格处断开，避免把一个词切成两半；实在没有再硬裁。
 */
export function clipAround(text: string, offset: number, maxChars = MAX_CONTEXT_CHARS): SentenceSpan {
  if (text.length <= maxChars) return { start: 0, end: text.length, text };

  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, offset - half);
  let end = Math.min(text.length, start + maxChars);
  start = Math.max(0, end - maxChars);

  // 起点向右挪到下一个空格之后（不要把词切一半），但别挪太多
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space - start < 20) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space !== -1 && end - space < 20) end = space;
  }
  return { start, end, text: text.slice(start, end) };
}

/**
 * 定位 `offset` 落在的句子，并按需裁剪。
 *
 * `offset` 落在句子之间的空白里（或越界）时，返回**前一句**——
 * 对「词在标点附近」这类情况，前一句几乎总是更合理的上下文。
 * 找不到任何句子时返回 null，调用方应放弃这一项而不是发一句空上下文。
 */
export function sentenceAt(
  text: string,
  offset: number,
  maxChars = MAX_CONTEXT_CHARS,
): SentenceSpan | null {
  if (text === '') return null;
  const spans = sentenceSpans(text);
  if (spans.length === 0) return null;

  let found: SentenceSpan | null = null;
  for (const span of spans) {
    if (offset < span.start) break;
    found = span;
  }
  const sentence = found ?? spans[0];
  if (!sentence) return null;

  const local = Math.min(Math.max(offset - sentence.start, 0), sentence.text.length);
  const clipped = clipAround(sentence.text, local, maxChars);
  return {
    start: sentence.start + clipped.start,
    end: sentence.start + clipped.end,
    text: clipped.text,
  };
}
