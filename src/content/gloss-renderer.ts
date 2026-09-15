/**
 * 释义渲染：把文本节点切成 [原文][标注][原文] 三段。
 *
 * 三条硬性约束：
 * - 只用 textContent / DocumentFragment 写 DOM，绝不拼 HTML 字符串；
 * - 记录自己创建的每个节点，卸载时能精确还原成原始文本；
 * - 不破坏原有选中、复制与链接行为（释义部分 user-select: none）。
 */

import type { LookupResult } from '../core/types.js';
import type { Token } from '../core/tokenizer.js';
import {
  DEF_CLASS,
  GLOSS_ID_ATTR,
  LEMMA_ATTR,
  MARK_ATTR,
  MARK_CLASS,
  MARK_SELECTOR,
} from './constants.js';

export interface GlossMatch {
  token: Token;
  result: LookupResult;
}

/** 一处已渲染的标注。`id` 是后续按处更新释义的句柄。 */
export interface RenderedGloss {
  id: number;
  lemma: string;
  /** 在传入 `renderNode` 的 `matches` 里的下标。 */
  matchIndex: number;
}

export interface RenderOptions {
  /** 释义是否附带词性。 */
  showPos: boolean;
  /** 样式变体，映射到 `wordmark-gloss--{style}` 类。 */
  style: 'subtle' | 'underline' | 'boxed';
  /**
   * 每渲染出一处标注回调一次。
   *
   * 语境义是异步取回的（本机打分服务），所以调用方需要拿到「这一处」的句柄，
   * 才能在结果回来后就地替换释义，而不是整页重渲染。
   */
  onGloss?: (gloss: RenderedGloss) => void;
}

interface GlossRecord {
  wrapper: HTMLElement;
  def: HTMLElement;
  /** 保留词性：更新语境义时仍要按原样拼 `（n.xxx）`。 */
  pos: string;
}

export class GlossRenderer {
  readonly #byLemma = new Map<string, HTMLElement[]>();
  /** 按处索引，键是渲染时分配的 id。 */
  readonly #byId = new Map<number, GlossRecord>();
  readonly #own = new WeakSet<Node>();
  #count = 0;
  #nextId = 1;

  get count(): number {
    return this.#count;
  }

  get uniqueCount(): number {
    return this.#byLemma.size;
  }

  /** 该节点是否由渲染器创建（observer 用它过滤掉自己触发的变更）。 */
  isOwn(node: Node): boolean {
    return this.#own.has(node);
  }

  /** 就地把一个文本节点中的若干词替换为「原词 + 中文释义」。 */
  renderNode(node: Text, matches: readonly GlossMatch[], options: RenderOptions): number {
    if (matches.length === 0 || !node.isConnected) return 0;
    const doc = node.ownerDocument;
    const text = node.data;
    // 带上调用方数组里的原始下标：`matchIndex` 要能索引回调用方自己的 matches
    const ordered = matches
      .map((match, index) => ({ match, index }))
      .sort((a, b) => a.match.token.start - b.match.token.start);
    const fragment = doc.createDocumentFragment();
    let cursor = 0;
    let inserted = 0;

    for (const { match, index } of ordered) {
      const { start, end } = match.token;
      // 防御：跳过重叠 / 越界区间（正常分词不会产生）。
      if (start < cursor || end > text.length || start >= end) continue;
      if (start > cursor) {
        fragment.appendChild(this.#ownText(doc, text.slice(cursor, start)));
      }

      const glossId = this.#nextId;
      this.#nextId += 1;

      const wrapper = doc.createElement('span');
      wrapper.className = `${MARK_CLASS} ${MARK_CLASS}--${options.style}`;
      wrapper.setAttribute(MARK_ATTR, '1');
      wrapper.setAttribute(LEMMA_ATTR, match.result.lemma);
      wrapper.setAttribute(GLOSS_ID_ATTR, String(glossId));
      wrapper.setAttribute('data-wordmark-source', match.result.source);

      wrapper.appendChild(this.#ownText(doc, text.slice(start, end)));

      const def = doc.createElement('span');
      def.className = DEF_CLASS;
      def.setAttribute(MARK_ATTR, '1');
      def.textContent = formatGloss(match.result, options.showPos);
      this.#own.add(def);

      wrapper.appendChild(def);
      this.#own.add(wrapper);
      fragment.appendChild(wrapper);

      const bucket = this.#byLemma.get(match.result.lemma);
      if (bucket) bucket.push(wrapper);
      else this.#byLemma.set(match.result.lemma, [wrapper]);

      this.#byId.set(glossId, {
        wrapper,
        def,
        pos: options.showPos ? (match.result.pos ?? '') : '',
      });
      options.onGloss?.({
        id: glossId,
        lemma: match.result.lemma,
        matchIndex: index,
      });

      cursor = end;
      inserted += 1;
      this.#count += 1;
    }

    if (inserted === 0) return 0;

    if (cursor < text.length) {
      fragment.appendChild(this.#ownText(doc, text.slice(cursor)));
    }
    // 保留原节点身份会导致偏移错乱，直接整体替换。
    node.replaceWith(fragment);
    return inserted;
  }

  /**
   * 就地替换某一处标注的释义文本（语境义结果回来时用）。
   *
   * 只改释义节点的文本，**不动**外壳、原词与文档结构——所以既不会触发重排，
   * 也不会让 MutationObserver 认为页面结构变了。
   * 返回是否命中：标注可能已经被用户「我认识」或整页还原移除，那时静默跳过即可。
   */
  updateGlossText(id: number, gloss: string): boolean {
    const record = this.#byId.get(id);
    if (!record) return false;
    if (!record.wrapper.isConnected) {
      this.#byId.delete(id);
      return false;
    }
    record.def.textContent = `（${record.pos}${gloss}）`;
    return true;
  }

  /** 取某处标注当前的释义文本（不含括号与词性前缀），主要给测试与调试用。 */
  glossTextOf(id: number): string | null {
    const record = this.#byId.get(id);
    if (!record) return null;
    const text = record.def.textContent ?? '';
    const inner = text.replace(/^（/, '').replace(/）$/, '');
    // 精确去掉前缀，而不是 replace（释义里可能恰好含有词性字样）
    return record.pos !== '' && inner.startsWith(record.pos) ? inner.slice(record.pos.length) : inner;
  }

  /** 移除某个词元的全部标注（用户点「我认识」时用）。 */
  removeLemma(lemma: string): number {
    const wrappers = this.#byLemma.get(lemma);
    if (!wrappers) return 0;
    let removed = 0;
    for (const wrapper of wrappers) {
      if (this.#unwrap(wrapper)) removed += 1;
    }
    this.#byLemma.delete(lemma);
    this.#count -= removed;
    return removed;
  }

  /** 还原整页：所有标注都变回原始文本节点。 */
  unmarkAll(root: ParentNode = document): void {
    const wrappers = [...root.querySelectorAll(MARK_SELECTOR)].filter(
      (node): node is HTMLElement => node.classList.contains(MARK_CLASS),
    );
    const parents = new Set<Node>();
    for (const wrapper of wrappers) {
      const parent = wrapper.parentNode;
      if (parent) parents.add(parent);
      this.#unwrap(wrapper);
    }
    // 合并被切碎的相邻文本节点，让 DOM 回到注入前的形态。
    for (const parent of parents) {
      const normalizable = parent as Node & { normalize?: () => void };
      normalizable.normalize?.();
    }
    this.#byLemma.clear();
    this.#byId.clear();
    this.#count = 0;
  }

  #ownText(doc: Document, value: string): Text {
    const node = doc.createTextNode(value);
    this.#own.add(node);
    return node;
  }

  /** 把 wrapper 换回纯文本；返回是否真的做了替换。 */
  #unwrap(wrapper: HTMLElement): boolean {
    const parent = wrapper.parentNode;
    if (!parent) return false;
    const doc = wrapper.ownerDocument;
    const id = Number(wrapper.getAttribute(GLOSS_ID_ATTR));
    if (Number.isInteger(id)) this.#byId.delete(id);
    // 第一个子节点一定是原始词形；释义节点被有意丢弃。
    const surface = wrapper.firstChild;
    const text = surface?.nodeType === 3 ? (surface as Text).data : '';
    // 原词可能带 `<wbr>` 之类的子元素，稳妥起见回退到去掉释义的 textContent。
    const restored =
      text !== ''
        ? text
        : [...wrapper.childNodes]
            .filter((child) => !(child instanceof Element && child.classList.contains(DEF_CLASS)))
            .map((child) => child.textContent ?? '')
            .join('');
    parent.replaceChild(this.#ownText(doc, restored), wrapper);
    return true;
  }
}

/** 释义文案：`（n.孩子）` 或 `（孩子）`。 */
export function formatGloss(result: LookupResult, showPos: boolean): string {
  const pos = showPos && result.pos ? result.pos.trim() : '';
  return `（${pos}${result.gloss}）`;
}
