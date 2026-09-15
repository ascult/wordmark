/**
 * 在线 provider（可插拔）。
 *
 * 只在 service worker 里构造：MV3 的扩展上下文不受页面 CORS 限制，
 * 请求集中在一处也便于做速率限制与缓存。
 *
 * 安全约定：第三方返回的文本一律当作不可信数据处理，
 * 经 sanitizeGloss 归一化后才可能进入 DOM，且渲染端只用 textContent。
 */

import type { DictionaryProvider, LookupResult } from '../core/types.js';
import type { OnlineProviderId } from '../core/settings.js';

export const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';

/** 释义长度上限，避免整段翻译灌进正文。 */
export const MAX_GLOSS_LENGTH = 24;

export interface RemoteDictionaryOptions {
  provider: OnlineProviderId;
  customUrl?: string;
  customPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 自定义接口必须是 https 且带 `{word}` 占位符。 */
export function isUsableCustomUrl(url: string): boolean {
  if (!url.includes('{word}')) return false;
  try {
    const parsed = new URL(url.replace('{word}', 'test'));
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 点路径取值，支持数组下标（`data.0.text`）。不执行任何代码。 */
export function getByPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const rawKey of path.split('.')) {
    const key = rawKey.trim();
    if (key === '') continue;
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (current !== null && typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return undefined;
  }
  return current;
}

/**
 * 把任意返回值收敛成一个可安全展示的短释义；不合格返回 null。
 */
export function sanitizeGloss(input: unknown, query?: string): string | null {
  if (typeof input !== 'string') return null;
  let text = input
    .normalize('NFKC')
    // 先去掉可能的标签片段，再压平控制字符与换行
    .replace(/<[^>]*>/g, ' ')
    // eslint-disable-next-line no-control-regex -- 有意匹配控制字符并替换成空格
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') return null;
  if (query !== undefined && text.toLowerCase() === query.toLowerCase()) return null;
  if (text.length > MAX_GLOSS_LENGTH) text = text.slice(0, MAX_GLOSS_LENGTH);
  text = text.replace(/[，。；、！？：,.;!?:]+$/u, '').trim();
  // 必须含中文，否则大概率是没翻出来的原文或错误提示。
  if (!/[\u4e00-\u9fff]/.test(text)) return null;
  if (/^(error|no query|invalid|too many)/i.test(text)) return null;
  return text;
}

export class RemoteDictionary implements DictionaryProvider {
  readonly kind = 'remote' as const;
  readonly #options: Required<Omit<RemoteDictionaryOptions, 'fetchImpl' | 'now'>> & {
    fetchImpl: typeof fetch;
    now: () => number;
  };

  constructor(options: RemoteDictionaryOptions) {
    this.#options = {
      provider: options.provider,
      customUrl: options.customUrl ?? '',
      customPath: options.customPath ?? 'responseData.translatedText',
      timeoutMs: options.timeoutMs ?? 6000,
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      now: options.now ?? (() => Date.now()),
    };
  }

  get id(): 'mymemory' | 'custom' {
    return this.#options.provider;
  }

  available(): boolean {
    if (this.#options.provider === 'mymemory') return true;
    return isUsableCustomUrl(this.#options.customUrl);
  }

  buildUrl(word: string): string {
    const encoded = encodeURIComponent(word);
    if (this.#options.provider === 'mymemory') {
      return `${MYMEMORY_ENDPOINT}?q=${encoded}&langpair=${encodeURIComponent('en|zh-CN')}`;
    }
    return this.#options.customUrl.replace('{word}', encoded);
  }

  async lookup(query: string, signal?: AbortSignal): Promise<LookupResult | null> {
    if (!this.available()) return null;
    const word = query.trim().toLowerCase();
    if (word === '' || !/^[a-z']+$/.test(word)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.#options.timeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);

    try {
      if (signal) {
        if (signal.aborted) return null;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const response = await this.#options.fetchImpl(this.buildUrl(word), {
        method: 'GET',
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      const raw = this.#extract(payload);
      const gloss = sanitizeGloss(raw, word);
      if (gloss === null) return null;
      return {
        lemma: word,
        surface: word,
        gloss,
        source: this.id,
        at: this.#options.now(),
      };
    } catch {
      // 网络失败 / 超时 / JSON 解析失败都按「未命中」处理，不影响本地标注。
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  #extract(payload: unknown): unknown {
    if (this.#options.provider === 'mymemory') {
      return getByPath(payload, 'responseData.translatedText');
    }
    return getByPath(payload, this.#options.customPath);
  }
}
