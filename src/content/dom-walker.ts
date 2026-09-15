/**
 * DOM 遍历：找出「值得标注的文本节点」。
 *
 * 两件事必须做对：
 * 1. 跳过非正文区域（代码块、输入框、可编辑区、隐藏节点、我们自己的产物）；
 * 2. 结果要缓存，否则一页几千个文本节点会重复走 N×depth 次祖先链。
 */

import { SKIP_SELECTOR, SKIP_TAGS } from './constants.js';

export interface DomWalkerOptions {
  /** 只接受至少包含一个 ASCII 字母的节点。 */
  extraSkipSelector?: string;
  /** 是否用 getComputedStyle 过滤不可见节点（单测里可关掉）。 */
  checkVisibility?: boolean;
}

export class DomWalker {
  readonly #root: ParentNode;
  readonly #skipTags: ReadonlySet<string>;
  readonly #skipSelector: string;
  readonly #cache = new WeakMap<Element, boolean>();
  readonly #checkVisibility: boolean;

  constructor(root: ParentNode, options: DomWalkerOptions = {}) {
    this.#root = root;
    this.#skipTags = SKIP_TAGS;
    this.#skipSelector = options.extraSkipSelector
      ? `${SKIP_SELECTOR},${options.extraSkipSelector}`
      : SKIP_SELECTOR;
    this.#checkVisibility = options.checkVisibility ?? true;
  }

  /** 元素本身是否位于忽略区（含祖先判断，结果带缓存）。 */
  isSkipped(element: Element | null): boolean {
    if (element === null) return true;
    const cached = this.#cache.get(element);
    if (cached !== undefined) return cached;

    const parent = element.parentElement;
    const result =
      (parent !== null && parent !== this.#root && this.isSkipped(parent)) ||
      this.#skipTags.has(element.tagName) ||
      (element.matches?.(this.#skipSelector) ?? false) ||
      !this.#isVisible(element);

    this.#cache.set(element, result);
    return result;
  }

  /** 该文本节点是否可作为标注候选。 */
  isTextCandidate(node: Text): boolean {
    if (!/[A-Za-z]/.test(node.data)) return false;
    return !this.isSkipped(node.parentElement);
  }

  /** 按文档顺序收集候选文本节点。 */
  collect(root: Node = this.#root as Node): Text[] {
    const doc = this.#documentOf(root);
    const view = doc.defaultView;
    const filter = view?.NodeFilter ?? undefined;
    const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */, {
      acceptNode: (node: Node): number => {
        const accept = filter?.FILTER_ACCEPT ?? 1;
        const reject = filter?.FILTER_REJECT ?? 2;
        return this.isTextCandidate(node as Text) ? accept : reject;
      },
    });

    const nodes: Text[] = [];
    let current = walker.nextNode();
    while (current !== null) {
      nodes.push(current as Text);
      current = walker.nextNode();
    }
    return nodes;
  }

  #isVisible(element: Element): boolean {
    if (!this.#checkVisibility) return true;
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== 'function') return true;
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false;
    }
    return true;
  }

  #documentOf(node: Node): Document {
    return node.ownerDocument ?? (node as unknown as Document);
  }
}

/** 统计一个字符串里是否含字母，供外部快速预筛。 */
export function hasLetters(text: string): boolean {
  return /[A-Za-z]/.test(text);
}
