/**
 * 在 DOM 里为某个单词取「它所在的句子」。
 *
 * 为什么不直接用文本节点自己的文本：句子的边界常常落在别的节点里。
 * `<p>The <b>engine</b> and the rudder drive great work.</p>` 里
 * 「engine」所在的文本节点只有 `engine` 三个字不到——把这个发去打模型，
 * 模型看到的是片段而不是句子，语境义就失去意义了。
 *
 * 做法：向上找最近的块级祖先 → 把该块的文本（**排除我们自己插入的释义**）
 * 拼成一段并记录每个文本节点的起始偏移 → 用词的段内偏移定位句子。
 *
 * 排除释义这一步是必须的，不是洁癖：标注过一次之后，段文本会变成
 * `The ubiquitous（无处不在的） idea spreads.`，中文释义混进英文上下文里，
 * 与训练数据（纯英文句子）不一致，会直接拉低挑选质量。
 */

import { sentenceAt, MAX_CONTEXT_CHARS } from '../core/sentence.js';
import { DEF_CLASS, SKIP_TAGS } from './constants.js';

/**
 * 视为「块级」的标签。
 *
 * 为什么不用 `getComputedStyle().display`：在 jsdom 下它基本不可用，
 * 而这段逻辑必须有单测覆盖；用固定标签表虽然朴素，但行为完全确定、可测。
 * 句子本来就是排版概念，这个表覆盖了正文里绝大多数容器。
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'P', 'DIV', 'LI', 'TD', 'TH', 'DD', 'DT', 'BLOCKQUOTE', 'FIGCAPTION',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'ARTICLE', 'SECTION', 'ASIDE',
  'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ADDRESS', 'SUMMARY', 'DETAILS', 'BODY',
]);

/** 向上最多看多少层，避免异常深的结构里做无谓的遍历。 */
const MAX_ANCESTOR_DEPTH = 12;

/**
 * 拼上下文时要跳过的容器：代码、表单、SVG 等（与 `SKIP_TAGS` 同源，
 * 但那套判定是按节点逐个走 DOM 的，这里需要在拼接时按祖先快速排除）。
 */
const CONTEXT_SKIP_SELECTOR = [...SKIP_TAGS].map((tag) => tag.toLowerCase()).join(',');

/** 找到最近的块级祖先；找不到时返回 body（有总比没有好）。 */
export function blockOf(node: Node): Element | null {
  const doc = node.ownerDocument;
  let current: Node | null = node.parentNode;
  let depth = 0;
  while (current && depth < MAX_ANCESTOR_DEPTH) {
    if (current.nodeType === 1) {
      const element = current as Element;
      if (BLOCK_TAGS.has(element.tagName)) return element;
    }
    current = current.parentNode;
    depth += 1;
  }
  return doc?.body ?? null;
}

interface BlockEntry {
  text: string;
  /** 每个参与拼接的文本节点 → 它在 `text` 里的起始偏移。 */
  offsets: Map<Text, number>;
}

/** 一个批次内共用的块文本索引。批内不渲染，所以缓存不会被写坏。 */
export class BlockIndex {
  readonly #cache = new WeakMap<Element, BlockEntry>();

  /** 该块「去掉中文释义后」的文本与各文本节点偏移（缓存）。 */
  entryOf(block: Element): BlockEntry {
    const cached = this.#cache.get(block);
    if (cached) return cached;

    let text = '';
    const offsets = new Map<Text, number>();
    // 只看元素后代的文本节点；TreeWalker 在 jsdom 与浏览器行为一致
    const doc = block.ownerDocument;
    const walker = doc.createTreeWalker(block, 0x04 /* NodeFilter.SHOW_TEXT */);
    let current = walker.nextNode();
    while (current) {
      const textNode = current as Text;
      if (!isInsideDef(textNode) && !isInsideSkip(textNode)) {
        offsets.set(textNode, text.length);
        text += textNode.data;
      }
      current = walker.nextNode();
    }

    const entry: BlockEntry = { text, offsets };
    this.#cache.set(block, entry);
    return entry;
  }

  /** 偏移（相对整个块文本）对应的句子文本。 */
  sentenceAtOffset(block: Element, offset: number, maxChars = MAX_CONTEXT_CHARS): string | null {
    const entry = this.entryOf(block);
    return sentenceAt(entry.text, offset, maxChars)?.text ?? null;
  }

  /**
   * 取 `node` 里第 `tokenStart` 个字符所在句子的文本。
   *
   * 返回 null 表示拿不到可用上下文（节点不在该块内、句子为空），
   * 调用方应当放弃这一项，而不是发一句空上下文给模型。
   */
  sentenceFor(node: Text, tokenStart: number, maxChars = MAX_CONTEXT_CHARS): string | null {
    const block = blockOf(node);
    if (!block) return null;
    const entry = this.entryOf(block);
    const base = entry.offsets.get(node);
    if (base === undefined) return null;
    return sentenceAt(entry.text, base + tokenStart, maxChars)?.text ?? null;
  }
}

/** 该文本节点是否位于我们插入的释义节点里。 */
function isInsideDef(node: Text): boolean {
  const parent = node.parentElement;
  return parent !== null && parent.closest(`.${DEF_CLASS}`) !== null;
}

/** 该文本节点是否位于不该进正文的容器里（代码、表单、SVG…）。 */
function isInsideSkip(node: Text): boolean {
  const parent = node.parentElement;
  return parent !== null && parent.closest(CONTEXT_SKIP_SELECTOR) !== null;
}
