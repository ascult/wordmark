import { afterEach, describe, expect, it } from 'vitest';
import { sendRequest, type WordmarkResponse } from '../src/core/messages.js';

/**
 * sendRequest 的契约:错误模式保留在返回值里,调用方决定降级策略。
 * chrome.runtime 不存在时同样返回失败,而不是 null。
 */

function installChrome(sendMessage: unknown): () => void {
  (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
  return () => {
    delete (globalThis as Record<string, unknown>).chrome;
  };
}

const REQUEST = { type: 'wordmark:get-state', host: '' } as const;

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('sendRequest 错误模式', () => {
  it('成功响应解包 data', async () => {
    const snapshot = { settings: {}, knownWords: [], hostBlocked: false };
    cleanup = installChrome(async () => ({ ok: true, data: snapshot }) satisfies WordmarkResponse<unknown>);
    const res = await sendRequest<{ settings: object }>(REQUEST);
    expect(res).toEqual({ ok: true, data: snapshot });
  });

  it('协议错误保留 error 文本,不与未命中混淆', async () => {
    cleanup = installChrome(async () => ({ ok: false, error: 'unhandled: x' }) satisfies WordmarkResponse<null>);
    const res = await sendRequest(REQUEST);
    expect(res).toEqual({ ok: false, error: 'unhandled: x' });
  });

  it('service worker 抛异常时返回失败', async () => {
    cleanup = installChrome(async () => {
      throw new Error('Extension context invalidated');
    });
    const res = await sendRequest(REQUEST);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Extension context invalidated');
  });

  it('没有响应(页面卸载)返回失败', async () => {
    cleanup = installChrome(async () => undefined);
    const res = await sendRequest(REQUEST);
    expect(res).toEqual({ ok: false, error: 'no response' });
  });

  it('没有扩展 runtime 时返回失败', async () => {
    const res = await sendRequest(REQUEST);
    expect(res).toEqual({ ok: false, error: 'no extension runtime' });
  });
});
