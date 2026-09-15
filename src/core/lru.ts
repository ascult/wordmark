/**
 * 极简 LRU 缓存，依赖 Map 的插入顺序保证淘汰顺序。
 *
 * 之所以不引第三方依赖：扩展的 content script 体积应尽量小，
 * 且这里需要的功能不到 60 行。
 */
export class LruCache<V> {
  readonly #capacity: number;
  readonly #map = new Map<string, V>();

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`LruCache capacity 必须为正整数，收到 ${capacity}`);
    }
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#map.size;
  }

  has(key: string): boolean {
    return this.#map.has(key);
  }

  get(key: string): V | undefined {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    // 命中后移到队尾（最近使用）。
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.#capacity) {
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      this.#map.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  /** 按「最久未使用 → 最近使用」顺序遍历，用于持久化。 */
  *entries(): IterableIterator<[string, V]> {
    yield* this.#map.entries();
  }

  clear(): void {
    this.#map.clear();
  }
}
