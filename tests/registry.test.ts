import { describe, expect, it, vi } from 'vitest';
import type { DictionaryProvider, LookupResult, ProviderId } from '../src/core/types.js';
import { DictionaryRegistry } from '../src/dict/registry.js';

/** 只做精确匹配的本地 provider，用来观察「候选词元」的尝试顺序。 */
function exactLocal(
  words: readonly string[],
  spy?: (query: string) => void,
  id: ProviderId = 'offline',
): DictionaryProvider {
  const hit = (query: string): LookupResult | null => {
    spy?.(query);
    if (!words.includes(query)) return null;
    return { lemma: query, surface: query, gloss: `释义-${query}`, source: id, at: 0 };
  };
  return {
    id,
    kind: 'local',
    available: () => true,
    lookupSync: hit,
    lookup: async (query) => hit(query),
  };
}

function remoteProvider(
  impl: (query: string, signal?: AbortSignal) => LookupResult | null,
  id: ProviderId = 'mymemory',
): DictionaryProvider {
  return {
    id,
    kind: 'remote',
    available: () => true,
    lookup: async (query, signal) => impl(query, signal),
  };
}

const remoteHit = (query: string): LookupResult => ({
  lemma: query,
  surface: query,
  gloss: `在线-${query}`,
  source: 'mymemory',
  at: 0,
});

describe('DictionaryRegistry 解析顺序', () => {
  it('按词形还原候选逐个尝试本地 provider', () => {
    const queries: string[] = [];
    const registry = new DictionaryRegistry().addLocal(
      exactLocal(['child'], (query) => queries.push(query)),
    );
    const result = registry.resolveSync('children');
    expect(result?.lemma).toBe('child');
    expect(queries).toEqual(['children', 'child']);
  });

  it('精确匹配优先，不会误还原', () => {
    const registry = new DictionaryRegistry();
    registry
      .addLocal(exactLocal(['studies']))
      .addLocal(exactLocal(['study']));
    expect(registry.resolveSync('studies')?.lemma).toBe('studies');
  });

  it('同步快路径命中本地时完全不涉及远程', () => {
    const remote = vi.fn(remoteHit);
    const registry = new DictionaryRegistry()
      .addLocal(exactLocal(['child']))
      .addRemote(remoteProvider(remote));
    expect(registry.resolveSync('child')?.source).toBe('offline');
    expect(remote).not.toHaveBeenCalled();
  });

  it('本地全失败才调用远程，且只调用一次（用原始词形）', async () => {
    const remote = vi.fn(remoteHit);
    const registry = new DictionaryRegistry()
      .addLocal(exactLocal(['child']))
      .addRemote(remoteProvider(remote));

    const result = await registry.resolve('ubiquitous');
    expect(remote).toHaveBeenCalledOnce();
    expect(remote).toHaveBeenCalledWith('ubiquitous', undefined);
    expect(result?.source).toBe('mymemory');
    expect(result?.surface).toBe('ubiquitous');
  });

  it('远程查询前剥掉所有格与缩写后缀', async () => {
    const remote = vi.fn(remoteHit);
    const registry = new DictionaryRegistry().addRemote(remoteProvider(remote));
    await registry.resolve("reader's");
    expect(remote).toHaveBeenCalledWith('reader', undefined);
  });

  it('命中结果进缓存，同一词不再重复查本地', async () => {
    const localSpy = vi.fn();
    const registry = new DictionaryRegistry().addLocal(exactLocal(['child'], localSpy));
    registry.resolveSync('child');
    const callsAfterFirst = localSpy.mock.calls.length;
    registry.resolveSync('child');
    expect(localSpy.mock.calls.length).toBe(callsAfterFirst);
    expect(registry.stats.hits).toBe(1);
  });

  it('未命中的词进负缓存，不再重复请求远程', async () => {
    const remote = vi.fn(() => null);
    const registry = new DictionaryRegistry().addRemote(remoteProvider(remote));
    expect(await registry.resolve('nowhere')).toBeNull();
    expect(await registry.resolve('nowhere')).toBeNull();
    expect(remote).toHaveBeenCalledOnce();
    expect(registry.stats.misses).toBeGreaterThan(0);
  });

  it('命中后清除对应候选的负缓存标记', async () => {
    const remote = vi.fn(remoteHit);
    const registry = new DictionaryRegistry().addRemote(remoteProvider(remote));
    await registry.resolve('child');
    // child 命中后，children 的候选链 ['children','child'] 应命中缓存
    const result = await registry.resolve('children');
    expect(result?.lemma).toBe('child');
    expect(remote).toHaveBeenCalledOnce();
  });

  it('禁用或未启用的 provider 会被跳过', async () => {
    const provider: DictionaryProvider = {
      id: 'offline',
      kind: 'local',
      available: () => false,
      lookup: async () => null,
      lookupSync: () => null,
    };
    const registry = new DictionaryRegistry().addLocal(provider);
    expect(await registry.resolve('child')).toBeNull();
  });

  it('addLocal / addRemote 校验 provider 类型', () => {
    const registry = new DictionaryRegistry();
    expect(() => registry.addLocal(remoteProvider(remoteHit))).toThrow(TypeError);
    expect(() => registry.addRemote(exactLocal(['x']))).toThrow(TypeError);
  });

  it('clearCache 后重新查询', async () => {
    const localSpy = vi.fn();
    const registry = new DictionaryRegistry().addLocal(exactLocal(['child'], localSpy));
    registry.resolveSync('child');
    const before = localSpy.mock.calls.length;
    registry.clearCache();
    registry.resolveSync('child');
    expect(localSpy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('resolveMany', () => {
  it('按规范化词形去重，结果以词形为键', async () => {
    const remote = vi.fn(remoteHit);
    const registry = new DictionaryRegistry().addRemote(remoteProvider(remote));
    const found = await registry.resolveMany(['Ubiquitous', 'ubiquitous', "reader's"]);
    expect(remote).toHaveBeenCalledTimes(2);
    // resolveMany 的键是「页面上的词形」，词元还原结果在 result.lemma 上
    expect([...found.keys()].sort()).toEqual(["reader's", 'ubiquitous']);
    expect(found.get('ubiquitous')?.lemma).toBe('ubiquitous');
  });

  it('空输入返回空 Map', async () => {
    const registry = new DictionaryRegistry();
    expect((await registry.resolveMany([])).size).toBe(0);
  });

  it('并发上限不会改变结果完整性', async () => {
    const registry = new DictionaryRegistry({ concurrency: 2 }).addRemote(
      remoteProvider((query) => remoteHit(query)),
    );
    const words = Array.from({ length: 25 }, (_, index) => `word${index}`);
    const found = await registry.resolveMany(words);
    expect(found.size).toBe(25);
  });
});
