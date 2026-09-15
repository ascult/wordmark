/**
 * 动态内容监听。
 *
 * 目标页面是 SPA / 无限滚动时，初始 DOM 只是冰山一角。这里用
 * MutationObserver 收集新增文本，去抖后批量交给上层处理。
 *
 * 关键点：必须过滤掉「我们自己插入的节点」，否则渲染会自激循环。
 */

import type { DomWalker } from './dom-walker.js';

export interface DomWatcherOptions {
  /** 合并变更的等待时间。 */
  debounceMs?: number;
  /** 单批上限，防止超长页面把内存吃满。 */
  maxQueue?: number;
  /** 判断节点是否由本扩展创建。 */
  isOwnNode?: (node: Node) => boolean;
}

export class DomWatcher {
  readonly #walker: DomWalker;
  readonly #onText: (nodes: Text[]) => void;
  readonly #debounceMs: number;
  readonly #maxQueue: number;
  readonly #isOwnNode: (node: Node) => boolean;
  readonly #queue = new Set<Text>();
  #observer: MutationObserver | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dropped = 0;

  constructor(
    walker: DomWalker,
    onText: (nodes: Text[]) => void,
    options: DomWatcherOptions = {},
  ) {
    this.#walker = walker;
    this.#onText = onText;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#maxQueue = options.maxQueue ?? 4000;
    this.#isOwnNode = options.isOwnNode ?? (() => false);
  }

  get pending(): number {
    return this.#queue.size;
  }

  get dropped(): number {
    return this.#dropped;
  }

  get running(): boolean {
    return this.#observer !== null;
  }

  start(root: Node): void {
    if (this.#observer !== null) return;
    const doc = root.ownerDocument;
    const MutationObserverImpl =
      doc?.defaultView?.MutationObserver ??
      (typeof MutationObserver === 'undefined' ? undefined : MutationObserver);
    if (!MutationObserverImpl) return;

    this.#observer = new MutationObserverImpl((records) => this.#ingest(records));
    this.#observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  stop(): void {
    this.#observer?.disconnect();
    this.#observer = null;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#queue.clear();
  }

  /** 立即处理已排队的节点（忽略去抖等待）。 */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const nodes = [...this.#queue];
    this.#queue.clear();
    if (nodes.length > 0) this.#onText(nodes);
  }

  #ingest(records: readonly MutationRecord[]): void {
    for (const record of records) {
      if (record.type === 'characterData') {
        this.#enqueue(record.target);
        continue;
      }
      for (const added of record.addedNodes) {
        if (this.#isOwnNode(added)) continue;
        if (added.nodeType === 3) {
          this.#enqueue(added);
          continue;
        }
        if (added.nodeType === 1) {
          for (const text of this.#walker.collect(added)) this.#enqueue(text);
        }
      }
      for (const removed of record.removedNodes) {
        if (removed.nodeType === 3) this.#queue.delete(removed as Text);
      }
    }
    this.#schedule();
  }

  #enqueue(node: Node): void {
    if (!this.#isOwnNode(node)) {
      const parent = (node as Text).parentElement ?? null;
      if (this.#walker.isSkipped(parent)) return;
    }
    if (node.nodeType !== 3) return;
    const text = node as Text;
    if (!/[A-Za-z]/.test(text.data)) return;
    if (this.#queue.size >= this.#maxQueue) {
      this.#dropped += 1;
      return;
    }
    this.#queue.add(text);
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.#debounceMs);
  }
}
