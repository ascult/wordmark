/**
 * content script ↔ service worker 的消息协议。
 *
 * 用可辨识联合保证两端 switch 的穷尽性；所有响应都包一层
 * `ok`，这样跨上下文的异常不会静默丢失。
 */

import type { Settings } from './settings.js';
import type { LookupResult } from './types.js';

/** 一个待挑选语境义的决策点：句子 + 目标词 + 页内标识。 */
export interface SenseRequestItem {
  id: string;
  sentence: string;
  word: string;
}

export interface PageStats {
  /** 内容脚本所在站点的 host——弹窗据此显示站点与站点规则，
   *  这样就不必依赖 `tab.url`（那需要 tabs/activeTab 权限）。 */
  host: string;
  /** 当前页面已插入的释义数量。 */
  glossed: number;
  /** 去重后的词元数量。 */
  unique: number;
  /** 字典中未命中、且未开启在线查询的候选词数量。 */
  unresolved: number;
  /** 页面是否被本扩展跳过。 */
  active: boolean;
}

export type WordmarkRequest =
  | { type: 'wordmark:lookup'; word: string }
  | { type: 'wordmark:sense'; items: SenseRequestItem[] }
  | { type: 'wordmark:mark-known'; word: string; known: boolean }
  | { type: 'wordmark:page-stats' }
  | { type: 'wordmark:get-state'; host: string }
  | { type: 'wordmark:set-site-enabled'; host: string; enabled: boolean }
  | { type: 'wordmark:set-settings'; patch: unknown }
  | { type: 'wordmark:set-known-words'; words: string[] }
  | { type: 'wordmark:clear-cache' }
  | { type: 'wordmark:apply-settings' };

export interface StateSnapshot {
  settings: Settings;
  knownWords: string[];
  hostBlocked: boolean;
}

export type WordmarkResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export interface LookupPayload {
  result: LookupResult | null;
}

export function isWordmarkRequest(value: unknown): value is WordmarkRequest {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && type.startsWith('wordmark:');
}

/**
 * 发送请求并解包响应。
 *
 * 错误模式是 interface 的一部分:协议错误、运行时不可用都会以
 * `{ ok: false, error }` 返回,不会与「未命中」混淆——是否降级、
 * 是否提示用户,由调用方决定。读路径(查词)通常把 !ok 当未命中,
 * 写路径(标记已知词)则应把失败反馈给用户。
 */
export type SendResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function sendRequest<T>(request: WordmarkRequest): Promise<SendResult<T>> {
  const api = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!api?.sendMessage) return { ok: false, error: 'no extension runtime' };
  try {
    const response = (await api.sendMessage(request)) as WordmarkResponse<T> | undefined;
    if (!response) return { ok: false, error: 'no response' };
    if (response.ok !== true) return { ok: false, error: response.error };
    return { ok: true, data: response.data };
  } catch (error) {
    // service worker 重启、页面卸载等都会走到这里。
    return { ok: false, error: String(error) };
  }
}
