import { describe, expect, it, vi } from 'vitest';
import { SenseSelector, type SenseCandidate } from '../src/core/sense-selector.js';
import {
  DEFAULT_SETTINGS,
  isLocalEndpointHost,
  sanitizeEndpoint,
  sanitizeSettings,
  type SenseSettings,
} from '../src/core/settings.js';

function senseSettings(patch: Partial<SenseSettings> = {}): SenseSettings {
  return { ...DEFAULT_SETTINGS.sense, enabled: true, ...patch };
}

function jsonResponse(payload: unknown, ok = true): Response {
  return {
    ok,
    json: async () => payload,
  } as unknown as Response;
}

const CANDIDATE: SenseCandidate = {
  id: 'a',
  sentence: 'Also, the engine and the rudder of great work.',
  word: 'engine',
};

const OK_PAYLOAD = {
  results: [
    {
      id: 'a',
      index: 1,
      selected: '驱动力/推动力',
      senses: ['发动机/引擎', '驱动力/推动力'],
      scores: [1.5, 4.2],
      ms: 41,
    },
  ],
};

describe('语境义客户端：绝不打扰正文', () => {
  it('默认关闭时不发任何请求', async () => {
    const fetchImpl = vi.fn();
    const selector = new SenseSelector({
      settings: () => senseSettings({ enabled: false }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const picks = await selector.pick([CANDIDATE]);
    expect(picks.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('endpoint 为空时不发请求', async () => {
    const fetchImpl = vi.fn();
    const selector = new SenseSelector({
      settings: () => senseSettings({ endpoint: '' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await selector.pick([CANDIDATE])).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('正常返回时映射回 id，并带出义项数与分数', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const picks = await selector.pick([CANDIDATE]);
    expect(picks.get('a')).toEqual({ sense: '驱动力/推动力', count: 2, scores: [1.5, 4.2] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8317/select');
    expect(JSON.parse(String(init.body))).toEqual({
      items: [{ id: 'a', sentence: CANDIDATE.sentence, word: 'engine' }],
    });
  });

  it('服务端 index: -1（词没得选）不算结果，但会被缓存成否定结果', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: [{ id: 'a', index: -1, reason: 'single-sense' }] }),
    );
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await selector.pick([CANDIDATE])).size).toBe(0);
    expect(selector.cached('engine', CANDIDATE.sentence)).toBeNull();
    // 第二次不该再问：否定结果也在缓存里
    await selector.pick([CANDIDATE]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('服务没起（fetch 抛错）时静默返回空，不抛', async () => {
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await expect(selector.pick([CANDIDATE])).resolves.toEqual(new Map());
  });

  it('请求失败不落缓存：下次重扫会再试', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await selector.pick([CANDIDATE]);
    // 失败不能被记成「这个词没得选」，否则一次超时会永久禁掉这一批
    expect(selector.cached('engine', CANDIDATE.sentence)).toBeUndefined();
    await selector.pick([CANDIDATE]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('记录服务是否可达，供弹窗判断「有没有在生效」', async () => {
    const alive = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: (async () => jsonResponse(OK_PAYLOAD)) as unknown as typeof fetch,
    });
    expect(alive.reachable()).toBeNull(); // 还没试过
    await alive.pick([CANDIDATE]);
    expect(alive.reachable()).toBe(true);

    const dead = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    await dead.pick([CANDIDATE]);
    expect(dead.reachable()).toBe(false);
  });

  it('按批切片发送，前一批失败不牵连后一批', async () => {
    let requestCount = 0;
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      requestCount += 1;
      if (requestCount === 1) throw new Error('timeout');
      return jsonResponse({ results: [] });
    });
    const selector = new SenseSelector({
      settings: () => senseSettings({ maxPerPage: 40 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `i${index}`,
      sentence: `Sentence number ${index} is long enough to matter.`,
      word: `word${index}`,
    }));
    await selector.pick(items);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const sizes = fetchImpl.mock.calls.map((entry) => {
      const [, init] = entry as unknown as [string, RequestInit];
      return (JSON.parse(String(init.body)).items as unknown[]).length;
    });
    expect(sizes).toEqual([32, 8]);
  });

  it('HTTP 错误 / 非 JSON / 形状不对，都只是没有结果', async () => {
    for (const impl of [
      async () => jsonResponse({}, false),
      async () =>
        ({
          ok: true,
          json: async () => {
            throw new SyntaxError('bad json');
          },
        }) as unknown as Response,
      async () => jsonResponse({ nope: 1 }),
      async () => jsonResponse({ results: [{ id: 'a', index: 0 }] }), // 缺 selected
      async () => jsonResponse({ results: [{ index: 0, selected: 'x' }] }), // 缺 id
    ]) {
      const selector = new SenseSelector({
        settings: () => senseSettings(),
        fetchImpl: impl as unknown as typeof fetch,
      });
      expect((await selector.pick([CANDIDATE])).size).toBe(0);
    }
  });

  it('命中缓存后不再请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await selector.pick([CANDIDATE]);
    const again = await selector.pick([{ ...CANDIDATE, id: 'b' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again.get('b')?.sense).toBe('驱动力/推动力');
  });

  it('同一句同词重复出现时只问一次', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OK_PAYLOAD));
    const selector = new SenseSelector({
      settings: () => senseSettings(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await selector.pick([CANDIDATE, { ...CANDIDATE, id: 'b' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.items).toHaveLength(1);
  });

  it('maxPerPage 限制单页发送量，且请求按上限截断', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }));
    const selector = new SenseSelector({
      settings: () => senseSettings({ maxPerPage: 2 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const items = Array.from({ length: 5 }, (_, index) => ({
      id: `i${index}`,
      sentence: `Sentence number ${index} is long enough to matter.`,
      word: `word${index}`,
    }));
    await selector.pick(items);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.items).toHaveLength(2);
  });

  it('maxPerPage 为 0 时完全停用', async () => {
    const fetchImpl = vi.fn();
    const selector = new SenseSelector({
      settings: () => senseSettings({ maxPerPage: 0 }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await selector.pick([CANDIDATE])).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('语境义设置校验', () => {
  it('默认关闭，且指向本机服务', () => {
    expect(DEFAULT_SETTINGS.sense.enabled).toBe(false);
    expect(DEFAULT_SETTINGS.sense.endpoint).toContain('127.0.0.1');
  });

  it('endpoint 只接受 http/https、拒绝内嵌凭据、去掉结尾斜杠', () => {
    expect(sanitizeEndpoint('http://127.0.0.1:8317/', 'x')).toBe('http://127.0.0.1:8317');
    expect(sanitizeEndpoint('https://192.168.1.5:1/base//', 'x')).toBe('https://192.168.1.5:1/base');
    expect(sanitizeEndpoint('javascript:alert(1)', 'fallback')).toBe('fallback');
    expect(sanitizeEndpoint('data:text/html,x', 'fallback')).toBe('fallback');
    expect(sanitizeEndpoint('http://user:pw@host', 'fallback')).toBe('fallback');
    expect(sanitizeEndpoint('不是地址', 'fallback')).toBe('fallback');
    expect(sanitizeEndpoint('', 'fallback')).toBe('');
  });

  it('endpoint 拒绝公网 host，且导入的配置也绕不开', () => {
    // 这是隐私承诺（docs/adr/0001）：整句不得出本机/局域网。
    for (const url of [
      'https://api.example.com',
      'https://example.com:443/select',
      'http://8.8.8.8:8317',
      'https://host:1/base',
    ]) {
      expect(sanitizeEndpoint(url, 'fallback')).toBe('fallback');
    }
    const imported = sanitizeSettings({
      sense: { enabled: true, endpoint: 'https://evil.example.com' },
    });
    expect(imported.sense.endpoint).toBe(DEFAULT_SETTINGS.sense.endpoint);
  });

  it('本机与局域网 host 的判定', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.10',
      '169.254.1.1',
      'fd00::1',
      'laptop.local',
      'box.home.arpa',
    ]) {
      expect(isLocalEndpointHost(host)).toBe(true);
    }
    for (const host of [
      '',
      'example.com',
      '8.8.8.8',
      '11.0.0.1',
      '172.32.0.1',
      'fe80::1',
      'notlocal',
      // 单标签主机名会落进 fc00::/7 的十六进制区间，但不是 IPv6 字面量
      'fc00',
      'fcc0',
      'fd0a',
      'fdfd',
    ]) {
      expect(isLocalEndpointHost(host)).toBe(false);
    }
  });

  it('sanitizeSettings 收敛越界值并保留缺省', () => {
    const settings = sanitizeSettings({
      sense: { enabled: true, endpoint: 'http://127.0.0.1:9999/', timeoutMs: 10, maxPerPage: 999999 },
    });
    expect(settings.sense.enabled).toBe(true);
    expect(settings.sense.endpoint).toBe('http://127.0.0.1:9999');
    expect(settings.sense.timeoutMs).toBe(500); // 抬到下限
    expect(settings.sense.maxPerPage).toBe(5000); // 压到上限

    const empty = sanitizeSettings({});
    expect(empty.sense).toEqual(DEFAULT_SETTINGS.sense);
  });

  it('旧的存储（没有 sense 字段）读出来仍然是合法设置', () => {
    const legacy = sanitizeSettings({ enabled: true, annotateFrom: 'cet4', online: { enabled: false } });
    expect(legacy.sense).toEqual(DEFAULT_SETTINGS.sense);
  });
});
