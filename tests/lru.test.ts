import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/core/lru.js';

describe('LruCache', () => {
  it('容量非法时抛错', () => {
    expect(() => new LruCache<number>(0)).toThrow(RangeError);
    expect(() => new LruCache<number>(1.5)).toThrow(RangeError);
  });

  it('超过容量后淘汰最久未使用的键', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.has('a')).toBe(false);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('get 命中会刷新使用顺序', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a'); // a 变成最近使用
    cache.set('c', 3); // 应淘汰 b
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('重复 set 同一键不会让容量虚增', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('a', 2);
    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(2);
  });

  it('支持 delete / entries / clear', () => {
    const cache = new LruCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    expect(cache.has('a')).toBe(false);
    expect([...cache.entries()]).toEqual([['b', 2]]);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
