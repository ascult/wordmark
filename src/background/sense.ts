/**
 * 语境义服务的「页内代理」：把打分请求从 content script 转发到本机服务。
 *
 * 为什么不让 content script 直接 fetch：内容脚本的请求算页面发起的，
 * 既受站点 CSP / CORS 约束，又会把本机服务地址暴露在页面上下文里。
 * 走 service worker 与在线词典是同一条路（见 `lookup.ts`）。
 *
 * 这里只做转发与超时，不打算分挑选逻辑——缓存与批次在页内（`core/sense-selector.ts`）。
 */

import type { SenseSettings } from '../core/settings.js';

export interface SenseRequestItem {
  id: string;
  sentence: string;
  word: string;
}

export interface SenseProxyOptions {
  /** 便于单测注入。 */
  fetchImpl?: typeof fetch;
}

export class SenseProxy {
  readonly #fetch: typeof fetch;

  constructor(options: SenseProxyOptions = {}) {
    this.#fetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /**
   * 转发一次挑选请求。返回服务端的 JSON（原样透传，形状由页内校验）；
   * 任何失败都返回 null——调用方据此保持词典义，不做任何提示。
   */
  async select(settings: SenseSettings, items: readonly SenseRequestItem[]): Promise<unknown | null> {
    if (!settings.enabled || settings.endpoint === '' || items.length === 0) return null;

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer =
      controller && settings.timeoutMs > 0
        ? setTimeout(() => controller.abort(), settings.timeoutMs)
        : null;

    try {
      const response = await this.#fetch(`${settings.endpoint}/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
        signal: controller?.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as unknown;
    } catch {
      return null;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
}
