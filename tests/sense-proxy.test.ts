import { describe, expect, it, vi } from 'vitest';
import { SenseProxy } from '../src/background/sense.js';
import { DEFAULT_SETTINGS, type SenseSettings } from '../src/core/settings.js';

function settings(patch: Partial<SenseSettings> = {}): SenseSettings {
  return { ...DEFAULT_SETTINGS.sense, enabled: true, ...patch };
}

const ITEMS = [{ id: '1', sentence: 'The engine drives work forward.', word: 'engine' }];

function jsonResponse(payload: unknown, ok = true): Response {
  return { ok, json: async () => payload } as unknown as Response;
}

describe('SenseProxy（service worker 侧的转发）', () => {
  it('关闭时不发请求', async () => {
    const fetchImpl = vi.fn();
    const proxy = new SenseProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await proxy.select(settings({ enabled: false }), ITEMS)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('地址为空时不发请求', async () => {
    const fetchImpl = vi.fn();
    const proxy = new SenseProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await proxy.select(settings({ endpoint: '' }), ITEMS)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('没有待办项时不发请求', async () => {
    const fetchImpl = vi.fn();
    const proxy = new SenseProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await proxy.select(settings(), [])).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('正常转发并把服务端 JSON 原样带回', async () => {
    const payload = { results: [{ id: '1', index: 1, selected: '驱动力/推动力' }] };
    const fetchImpl = vi.fn(async () => jsonResponse(payload));
    const proxy = new SenseProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await proxy.select(settings(), ITEMS)).toEqual(payload);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8317/select');
    expect(JSON.parse(String(init.body))).toEqual({ items: ITEMS });
  });

  it('HTTP 错误、非法 JSON、网络异常都返回 null（页面保持词典义）', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => jsonResponse({}, false),
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
      async () => {
        throw new Error('ECONNREFUSED');
      },
    ];
    for (const impl of cases) {
      const proxy = new SenseProxy({ fetchImpl: impl as unknown as typeof fetch });
      expect(await proxy.select(settings(), ITEMS)).toBeNull();
    }
  });

  it('超时会中止请求并返回 null，而不是一直挂着', async () => {
    // 永不 resolve 的 fetch，只有在 abort 时才 reject
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const proxy = new SenseProxy({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const started = Date.now();
    expect(await proxy.select(settings({ timeoutMs: 30 }), ITEMS)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeDefined();
  });
});
