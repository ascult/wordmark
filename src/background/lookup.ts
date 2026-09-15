/**
 * 跨标签页共享的在线查询。
 *
 * 接口只有一个 `lookup(word, online)`:正/负缓存、令牌桶式限流、
 * 去抖落盘与 provider 构造全部收在实现里,消息层只做转发。
 *
 * service worker 会被随时回收,因此缓存以 chrome.storage.local 为准,
 * 内存 LRU 只是热数据层。缓存键统一走 normalizeToken,与 registry 的
 * 页内缓存的归一化口径一致,不会出现两层各查各的。
 */

import { LruCache } from '../core/lru.js';
import type { OnlineSettings, StorageArea } from '../core/settings.js';
import { normalizeToken } from '../core/tokenizer.js';
import type { LookupResult } from '../core/types.js';
import { RemoteDictionary } from '../dict/remote.js';

const CACHE_KEY = 'wordmark:lookupCache.v1';
const CACHE_LIMIT = 2000;
/** 负缓存上限:避免反复请求同一个查不到的词。 */
const MISS_LIMIT = 2000;

interface PersistedCache {
  version: 1;
  entries: Record<string, LookupResult>;
}

export interface OnlineLookupOptions {
  /** 持久化后端(通常是 `storageArea('local')`);测试注入内存实现。 */
  storage: StorageArea;
  /** 注入点:测试用假 fetch,不用真发请求。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
  flushDelayMs?: number;
}

export class OnlineLookup {
  readonly #hits = new LruCache<LookupResult>(CACHE_LIMIT);
  readonly #misses = new LruCache<true>(MISS_LIMIT);
  readonly #storage: StorageArea;
  readonly #fetchImpl: typeof fetch;
  readonly #now: () => number;
  readonly #flushDelayMs: number;
  /** 最近一分钟内的时间戳,用于令牌桶式限流。 */
  readonly #requestStamps: number[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #hydrated = false;

  constructor(options: OnlineLookupOptions) {
    this.#storage = options.storage;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#flushDelayMs = options.flushDelayMs ?? 3000;
  }

  /**
   * 查一个词。`online` 由调用方从设置里取出传入——本模块不关心
   * 设置怎么加载、怎么迁移,只按给定的在线配置行事。
   */
  async lookup(word: string, online: OnlineSettings): Promise<LookupResult | null> {
    const key = normalizeToken(word.trim());
    if (key === '') return null;

    await this.#hydrate();
    const cached = this.#hits.get(key);
    if (cached) return { ...cached, surface: word, at: this.#now() };
    if (this.#misses.has(key)) return null;

    if (!online.enabled) return null;
    if (!this.#allowRequest(online.maxRequestsPerMinute)) return null;

    const provider = new RemoteDictionary({
      provider: online.provider,
      customUrl: online.customUrl,
      customPath: online.customPath,
      timeoutMs: online.timeoutMs,
      fetchImpl: this.#fetchImpl,
      now: this.#now,
    });
    if (!provider.available()) return null;

    const result = await provider.lookup(key);
    if (!result) {
      this.#misses.set(key, true);
      return null;
    }
    this.#hits.set(key, result);
    this.#scheduleFlush();
    return { ...result, surface: word, at: this.#now() };
  }

  /** 清空正/负缓存并删除落盘数据(设置页的「清空缓存」按钮)。 */
  async clear(): Promise<void> {
    this.#hits.clear();
    this.#misses.clear();
    try {
      await this.#storage.remove?.(CACHE_KEY);
    } catch {
      // 删不掉就让下一次 flush 覆盖它。
    }
  }

  #allowRequest(perMinute: number): boolean {
    const now = this.#now();
    while (this.#requestStamps.length > 0 && now - (this.#requestStamps[0] ?? 0) > 60_000) {
      this.#requestStamps.shift();
    }
    if (this.#requestStamps.length >= perMinute) return false;
    this.#requestStamps.push(now);
    return true;
  }

  async #hydrate(): Promise<void> {
    if (this.#hydrated) return;
    this.#hydrated = true;
    try {
      const stored = await this.#storage.get(CACHE_KEY);
      const payload = stored[CACHE_KEY] as PersistedCache | undefined;
      if (payload?.version === 1 && payload.entries) {
        for (const [key, value] of Object.entries(payload.entries)) this.#hits.set(key, value);
      }
    } catch {
      // 缓存坏了不影响功能,直接重建。
    }
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flush();
    }, this.#flushDelayMs);
  }

  async #flush(): Promise<void> {
    const entries: Record<string, LookupResult> = {};
    for (const [key, value] of this.#hits.entries()) entries[key] = value;
    const payload: PersistedCache = { version: 1, entries };
    try {
      await this.#storage.set({ [CACHE_KEY]: payload });
    } catch {
      // 配额不足时放弃持久化,内存缓存仍然有效。
    }
  }
}
