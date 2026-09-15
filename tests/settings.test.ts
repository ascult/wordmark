import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  addKnownWord,
  isHostBlocked,
  loadKnownWords,
  loadSettings,
  mergeSettings,
  removeKnownWord,
  sanitizeSettings,
  saveKnownWords,
  saveSettings,
} from '../src/core/settings.js';

beforeEach(async () => {
  // 没有 chrome.storage 时存储层退化为内存实现，测试之间需要重置。
  await saveSettings(DEFAULT_SETTINGS);
  await saveKnownWords([]);
});

describe('sanitizeSettings', () => {
  it('空输入得到默认值', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it('把越界数值夹到合法区间', () => {
    const settings = sanitizeSettings({
      minWordLength: 999,
      maxGlossesPerPage: -5,
      online: { timeoutMs: 10, maxRequestsPerMinute: 100000 },
    });
    expect(settings.minWordLength).toBe(12);
    expect(settings.maxGlossesPerPage).toBe(20);
    expect(settings.online.timeoutMs).toBe(1000);
    expect(settings.online.maxRequestsPerMinute).toBe(120);
  });

  it('非法枚举回落到默认值', () => {
    const settings = sanitizeSettings({ annotateFrom: 'cet99', repeatMode: 'never' });
    expect(settings.annotateFrom).toBe('cet4');
    expect(settings.repeatMode).toBe('first');
  });

  it('清洗 host 列表：去重、小写、去空', () => {
    const settings = sanitizeSettings({ blockedHosts: [' Example.com ', 'example.com', 42, ''] });
    expect(settings.blockedHosts).toEqual(['example.com']);
  });

  it('在线释义默认关闭（隐私优先）', () => {
    expect(DEFAULT_SETTINGS.online.enabled).toBe(false);
  });
});

describe('mergeSettings', () => {
  it('局部更新不影响其它字段', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { minWordLength: 5 });
    expect(next.minWordLength).toBe(5);
    expect(next.annotateFrom).toBe(DEFAULT_SETTINGS.annotateFrom);
  });

  it('嵌套的 online 字段是深合并', () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { online: { enabled: true } });
    expect(next.online.enabled).toBe(true);
    expect(next.online.timeoutMs).toBe(DEFAULT_SETTINGS.online.timeoutMs);
    expect(next.online.provider).toBe(DEFAULT_SETTINGS.online.provider);
  });
});

describe('isHostBlocked', () => {
  it('无规则时不屏蔽', () => {
    expect(isHostBlocked('example.com', [])).toBe(false);
  });

  it('裸域规则同时匹配自身与子域', () => {
    expect(isHostBlocked('example.com', ['example.com'])).toBe(true);
    expect(isHostBlocked('news.example.com', ['example.com'])).toBe(true);
  });

  it('通配规则只匹配子域', () => {
    expect(isHostBlocked('news.example.com', ['*.example.com'])).toBe(true);
    expect(isHostBlocked('example.com', ['*.example.com'])).toBe(false);
  });

  it('www 前缀被忽略，且不做后缀误伤', () => {
    expect(isHostBlocked('www.example.com', ['example.com'])).toBe(true);
    expect(isHostBlocked('notexample.com', ['example.com'])).toBe(false);
  });
});

describe('存储层', () => {
  it('设置可往返读写', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, minWordLength: 7 });
    expect((await loadSettings()).minWordLength).toBe(7);
  });

  it('已知词表去重追加与删除', async () => {
    await addKnownWord('Child');
    await addKnownWord('child');
    await addKnownWord('ubiquitous');
    expect(await loadKnownWords()).toEqual(['child', 'ubiquitous']);
    expect(await removeKnownWord('child')).toEqual(['ubiquitous']);
  });
});
