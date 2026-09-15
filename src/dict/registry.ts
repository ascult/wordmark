/**
 * provider 编排：候选词元 → 本地 provider → 远程 provider → 缓存。
 *
 * 查找顺序刻意如此：
 * 1. 先按词形还原候选逐个查本地词表（同步、免费、离线）；
 * 2. 本地全失败才动用远程（一次请求，避免为每个候选打一次网络）；
 * 3. 正/负结果都进 LRU，滚动长文不会重复查询。
 */

import { lemmaCandidates } from '../core/lemmatizer.js';
import { LruCache } from '../core/lru.js';
import { normalizeToken, stripClitics } from '../core/tokenizer.js';
import type { DictionaryProvider, LookupResult } from '../core/types.js';

/** 缓存里存的是「与词形无关」的命中信息，surface/at 在返回时再补。 */
type CachedHit = Omit<LookupResult, 'surface' | 'at'>;

export interface RegistryOptions {
  cacheSize?: number;
  missCacheSize?: number;
  /** resolveMany 的并发上限（远程查询时生效）。 */
  concurrency?: number;
  now?: () => number;
}

export class DictionaryRegistry {
  readonly #locals: DictionaryProvider[] = [];
  readonly #remotes: DictionaryProvider[] = [];
  readonly #hits: LruCache<CachedHit>;
  readonly #misses: LruCache<true>;
  readonly #concurrency: number;
  readonly #now: () => number;

  constructor(options: RegistryOptions = {}) {
    this.#hits = new LruCache<CachedHit>(options.cacheSize ?? 5000);
    this.#misses = new LruCache<true>(options.missCacheSize ?? 5000);
    this.#concurrency = Math.max(1, options.concurrency ?? 6);
    this.#now = options.now ?? (() => Date.now());
  }

  addLocal(provider: DictionaryProvider): this {
    if (provider.kind !== 'local') throw new TypeError(`${provider.id} 不是 local provider`);
    this.#locals.push(provider);
    return this;
  }

  addRemote(provider: DictionaryProvider): this {
    if (provider.kind !== 'remote') throw new TypeError(`${provider.id} 不是 remote provider`);
    this.#remotes.push(provider);
    return this;
  }

  get localProviders(): readonly DictionaryProvider[] {
    return this.#locals;
  }

  get remoteProviders(): readonly DictionaryProvider[] {
    return this.#remotes;
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.#hits.size, misses: this.#misses.size };
  }

  clearCache(): void {
    this.#hits.clear();
    this.#misses.clear();
  }

  /**
   * 同步快路径：只要某个本地 provider 能同步命中就直接返回。
   * 整页几千个词元时，这一层能把绝大部分查询挡在 Promise 之外。
   */
  resolveSync(surface: string): LookupResult | null {
    const candidates = lemmaCandidates(surface);
    for (const candidate of candidates) {
      const cached = this.#hits.get(candidate);
      if (cached) return this.#materialize(cached, surface);
    }
    for (const provider of this.#locals) {
      if (!provider.available() || !provider.lookupSync) continue;
      for (const candidate of candidates) {
        const result = provider.lookupSync(candidate);
        if (result) {
          this.#remember(result, candidates);
          return this.#materialize(result, surface);
        }
      }
    }
    return null;
  }

  /**
   * 完整解析：先同步快路径，再依次尝试本地 / 远程 provider。
   */
  async resolve(surface: string, signal?: AbortSignal): Promise<LookupResult | null> {
    const fast = this.resolveSync(surface);
    if (fast) return fast;

    const candidates = lemmaCandidates(surface);
    // 所有候选都被负缓存过 → 不必再打网络。
    if (candidates.every((candidate) => this.#misses.has(candidate))) return null;

    for (const provider of this.#locals) {
      if (!provider.available()) continue;
      for (const candidate of candidates) {
        if (signal?.aborted) return null;
        const result = await provider.lookup(candidate, signal);
        if (result) {
          this.#remember(result, candidates);
          return this.#materialize(result, surface);
        }
      }
    }

    const normalized = stripClitics(normalizeToken(surface));
    for (const provider of this.#remotes) {
      if (!provider.available()) continue;
      if (signal?.aborted) return null;
      const result = await provider.lookup(normalized, signal);
      if (result) {
        this.#remember(result, candidates);
        return this.#materialize(result, surface);
      }
    }

    for (const candidate of candidates) this.#misses.set(candidate, true);
    return null;
  }

  /**
   * 批量解析（带并发上限）。返回值以规范化词形为键，
   * 未命中不会出现在 Map 里。
   */
  async resolveMany(
    surfaces: Iterable<string>,
    signal?: AbortSignal,
  ): Promise<Map<string, LookupResult>> {
    const unique = new Set<string>();
    for (const surface of surfaces) {
      const key = normalizeToken(surface);
      if (key !== '') unique.add(key);
    }

    const found = new Map<string, LookupResult>();
    const queue = [...unique];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        if (signal?.aborted) return;
        const surface = queue[cursor];
        cursor += 1;
        if (surface === undefined) continue;
        const result = await this.resolve(surface, signal);
        if (result) found.set(surface, result);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.#concurrency, queue.length) },
      () => worker(),
    );
    await Promise.all(workers);
    return found;
  }

  #remember(result: LookupResult, candidates: readonly string[]): void {
    const hit: CachedHit = {
      lemma: result.lemma,
      gloss: result.gloss,
      source: result.source,
      ...(result.pos === undefined ? {} : { pos: result.pos }),
      ...(result.level === undefined ? {} : { level: result.level }),
    };
    this.#hits.set(result.lemma, hit);
    for (const candidate of candidates) this.#misses.delete(candidate);
  }

  #materialize(hit: CachedHit, surface: string): LookupResult {
    return { ...hit, surface, at: this.#now() };
  }
}
