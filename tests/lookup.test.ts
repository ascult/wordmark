import { describe, expect, it, vi } from 'vitest';
import { OnlineLookup } from '../src/background/lookup.js';
import { DEFAULT_SETTINGS, type OnlineSettings } from '../src/core/settings.js';

const ONLINE: OnlineSettings = { ...DEFAULT_SETTINGS.online, enabled: true };

/** 内存版 chrome.storage.local,测试持久化行为。 */
function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) if (map.has(key)) out[key] = map.get(key);
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) map.delete(key);
    },
    dump: map,
  };
}

function fetchStub(payload: unknown, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => payload }) as unknown as Response);
}

const MYMEMORY_OK = { responseData: { translatedText: '你好' } };

function makeLookup(storage: ReturnType<typeof memoryStorage>, fetchImpl: ReturnType<typeof fetchStub>) {
  return new OnlineLookup({ storage, fetchImpl, flushDelayMs: 5 });
}

describe('OnlineLookup', () => {
  it('命中后同一单词不再发请求', async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchStub(MYMEMORY_OK);
    const lookup = makeLookup(storage, fetchImpl);

    const first = await lookup.lookup('hello', ONLINE);
    expect(first?.gloss).toBe('你好');
    const second = await lookup.lookup('hello', ONLINE);
    expect(second?.gloss).toBe('你好');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('缓存键统一走 normalizeToken:弯撇号与直撇号共享一条缓存', async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchStub(MYMEMORY_OK);
    const lookup = makeLookup(storage, fetchImpl);

    await lookup.lookup("it's", ONLINE);
    const hit = await lookup.lookup('it’s', ONLINE);
    expect(hit?.gloss).toBe('你好');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('无效释义记入负缓存,第二次不再发请求', async () => {
    const storage = memoryStorage();
    // 返回的文本不含中文,sanitizeGloss 会拒绝它
    const fetchImpl = fetchStub({ responseData: { translatedText: 'hello' } });
    const lookup = makeLookup(storage, fetchImpl);

    expect(await lookup.lookup('hello', ONLINE)).toBeNull();
    expect(await lookup.lookup('hello', ONLINE)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('限流生效:每分钟 1 次时第二个词直接失败', async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchStub(MYMEMORY_OK);
    const lookup = makeLookup(storage, fetchImpl);
    const tight = { ...ONLINE, maxRequestsPerMinute: 1 };

    expect(await lookup.lookup('hello', tight)).not.toBeNull();
    expect(await lookup.lookup('world', tight)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('在线开关关闭时不发请求', async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchStub(MYMEMORY_OK);
    const lookup = makeLookup(storage, fetchImpl);

    expect(await lookup.lookup('hello', { ...ONLINE, enabled: false })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('落盘后新实例直接从持久层命中', async () => {
    const storage = memoryStorage();
    const first = makeLookup(storage, fetchStub(MYMEMORY_OK));
    await first.lookup('hello', ONLINE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(storage.dump.has('wordmark:lookupCache.v1')).toBe(true);

    // 新实例(模拟 SW 被回收后重启):fetch 一旦被调用就让测试失败
    const rejectFetch = vi.fn(async () => {
      throw new Error('不应发请求');
    });
    const second = new OnlineLookup({ storage, fetchImpl: rejectFetch as unknown as typeof fetch });
    const hit = await second.lookup('hello', ONLINE);
    expect(hit?.gloss).toBe('你好');
    expect(rejectFetch).not.toHaveBeenCalled();
  });

  it('clear() 清空内存缓存并删除落盘数据', async () => {
    const storage = memoryStorage();
    const fetchImpl = fetchStub(MYMEMORY_OK);
    const lookup = makeLookup(storage, fetchImpl);
    await lookup.lookup('hello', ONLINE);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await lookup.clear();
    expect(storage.dump.has('wordmark:lookupCache.v1')).toBe(false);

    // 缓存已清空:同一实例再查同一个词必须真的重新发请求
    const before = fetchImpl.mock.calls.length;
    await lookup.lookup('hello', ONLINE);
    expect(fetchImpl.mock.calls.length).toBe(before + 1);
  });
});
