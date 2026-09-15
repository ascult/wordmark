import { describe, expect, it, vi } from 'vitest';
import {
  MAX_GLOSS_LENGTH,
  MYMEMORY_ENDPOINT,
  RemoteDictionary,
  getByPath,
  isUsableCustomUrl,
  sanitizeGloss,
} from '../src/dict/remote.js';

describe('getByPath', () => {
  const payload = { data: { items: [{ text: '好' }], count: 1 } };

  it('按点路径取值', () => {
    expect(getByPath(payload, 'data.items.0.text')).toBe('好');
    expect(getByPath(payload, 'data.count')).toBe(1);
  });

  it('路径不存在时返回 undefined，不抛错', () => {
    expect(getByPath(payload, 'data.missing.deep')).toBeUndefined();
    expect(getByPath(payload, 'data.items.9.text')).toBeUndefined();
    expect(getByPath(null, 'a.b')).toBeUndefined();
  });
});

describe('sanitizeGloss', () => {
  it('保留正常中文释义并去掉尾部标点', () => {
    expect(sanitizeGloss('孩子')).toBe('孩子');
    expect(sanitizeGloss('无处不在的，')).toBe('无处不在的');
  });

  it('剥掉标签与控制字符', () => {
    expect(sanitizeGloss('<b>孩子</b>')).toBe('孩子');
    // 控制字符会被压平成空格，避免把两段粘连成错词
    expect(sanitizeGloss('<b>孩\u0000子</b>')).toBe('孩 子');
    expect(sanitizeGloss('孩\n子')).toBe('孩 子');
  });

  it('截断超长释义', () => {
    const long = '很'.repeat(100);
    expect(sanitizeGloss(long)).toHaveLength(MAX_GLOSS_LENGTH);
  });

  it('拒绝没有中文的返回值（多半是没翻出来）', () => {
    expect(sanitizeGloss('hello')).toBeNull();
    expect(sanitizeGloss('NO QUERY SPECIFIED')).toBeNull();
  });

  it('拒绝与查询词相同的回显', () => {
    expect(sanitizeGloss('child', 'child')).toBeNull();
  });

  it('拒绝空值与非字符串', () => {
    expect(sanitizeGloss('')).toBeNull();
    expect(sanitizeGloss(undefined)).toBeNull();
    expect(sanitizeGloss({ text: '孩子' })).toBeNull();
  });
});

describe('isUsableCustomUrl', () => {
  it('必须是 https 且带占位符', () => {
    expect(isUsableCustomUrl('https://api.example.com/d?q={word}')).toBe(true);
    expect(isUsableCustomUrl('http://api.example.com/d?q={word}')).toBe(false);
    expect(isUsableCustomUrl('https://api.example.com/d?q=x')).toBe(false);
    expect(isUsableCustomUrl('not a url {word}')).toBe(false);
  });
});

describe('RemoteDictionary', () => {
  const jsonResponse = (body: unknown, ok = true): Response =>
    ({
      ok,
      json: async () => body,
    }) as Response;

  it('MyMemory：拼出正确 URL 并解析 responseData.translatedText', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ responseData: { translatedText: '孩子' } }),
    );
    const dict = new RemoteDictionary({ provider: 'mymemory', fetchImpl: fetchImpl as never });
    const result = await dict.lookup('child');

    expect(fetchImpl).toHaveBeenCalledOnce();
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url.startsWith(MYMEMORY_ENDPOINT)).toBe(true);
    expect(url).toContain('q=child');
    expect(url).toContain(encodeURIComponent('en|zh-CN'));
    expect(result).toMatchObject({ lemma: 'child', gloss: '孩子', source: 'mymemory' });
  });

  it('非 2xx 响应按未命中处理', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false));
    const dict = new RemoteDictionary({ provider: 'mymemory', fetchImpl: fetchImpl as never });
    expect(await dict.lookup('child')).toBeNull();
  });

  it('网络异常不抛出，只返回 null', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const dict = new RemoteDictionary({ provider: 'mymemory', fetchImpl: fetchImpl as never });
    await expect(dict.lookup('child')).resolves.toBeNull();
  });

  it('超时会中断请求并返回 null', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const dict = new RemoteDictionary({
      provider: 'mymemory',
      timeoutMs: 5,
      fetchImpl: fetchImpl as never,
    });
    await expect(dict.lookup('child')).resolves.toBeNull();
  });

  it('自定义接口：走模板 + 点路径，且不可用时直接返回 null', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: { items: [{ gloss: '审查' }] } }),
    );
    const dict = new RemoteDictionary({
      provider: 'custom',
      customUrl: 'https://api.example.com/dict?q={word}',
      customPath: 'data.items.0.gloss',
      fetchImpl: fetchImpl as never,
    });
    const result = await dict.lookup('scrutinise');
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://api.example.com/dict?q=scrutinise');
    expect(result?.gloss).toBe('审查');

    const broken = new RemoteDictionary({ provider: 'custom', customUrl: 'http://insecure/{word}' });
    expect(broken.available()).toBe(false);
    expect(await broken.lookup('child')).toBeNull();
  });

  it('只查询纯字母词，挡住注入式的输入', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ responseData: { translatedText: '孩子' } }));
    const dict = new RemoteDictionary({ provider: 'mymemory', fetchImpl: fetchImpl as never });
    expect(await dict.lookup('<script>')).toBeNull();
    expect(await dict.lookup('')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
