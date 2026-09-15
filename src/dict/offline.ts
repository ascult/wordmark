/**
 * 内置离线词表 provider。
 *
 * 数据来自 `data/parts/*.json`，由 `npm run dict` 合并校验后写入
 * `src/data/dict.zh.json`，再被 esbuild 打进 content script。
 * 完全离线、零网络请求，是「生词判定」的默认依据。
 */

import rawDict from '../data/dict.zh.json';
import type { DictEntry, DictionaryProvider, LookupResult } from '../core/types.js';

const BUNDLED = rawDict as unknown as DictEntry[];

export interface OfflineDictionaryOptions {
  /** 由设置决定是否启用；禁用时 registry 会跳过它。 */
  enabled?: () => boolean;
  /** 覆盖内置数据，便于测试。 */
  entries?: DictEntry[];
  /** 结果时间戳注入点，便于测试。 */
  now?: () => number;
}

export class OfflineDictionary implements DictionaryProvider {
  readonly id = 'offline' as const;
  readonly kind = 'local' as const;

  readonly #index = new Map<string, DictEntry>();
  readonly #enabled: () => boolean;
  readonly #now: () => number;

  constructor(options: OfflineDictionaryOptions = {}) {
    this.#enabled = options.enabled ?? (() => true);
    this.#now = options.now ?? (() => Date.now());
    for (const entry of options.entries ?? BUNDLED) {
      this.#index.set(entry.word, entry);
    }
    // alt 变体建立反查，但不覆盖已有的正式词条。
    for (const entry of this.#index.values()) {
      for (const alt of entry.alt ?? []) {
        const key = alt.toLowerCase();
        if (!this.#index.has(key)) this.#index.set(key, entry);
      }
    }
  }

  get size(): number {
    return this.#index.size;
  }

  available(): boolean {
    return this.#enabled();
  }

  lookupSync(query: string): LookupResult | null {
    if (!this.available()) return null;
    const entry = this.#index.get(query);
    if (!entry) return null;
    return {
      lemma: entry.word,
      surface: query,
      gloss: entry.gloss,
      pos: entry.pos,
      level: entry.level,
      source: this.id,
      at: this.#now(),
    };
  }

  async lookup(query: string): Promise<LookupResult | null> {
    return this.lookupSync(query);
  }
}

/** 便于测试与统计：拿到合并后的原始条目。 */
export function bundledEntries(): DictEntry[] {
  return [...BUNDLED];
}
