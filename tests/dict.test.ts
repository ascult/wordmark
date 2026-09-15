import { describe, expect, it } from 'vitest';
import dictJson from '../src/data/dict.zh.json';
import { OfflineDictionary, bundledEntries } from '../src/dict/offline.js';
import { LEVELS, type DictEntry } from '../src/core/types.js';

const DICT = dictJson as unknown as DictEntry[];

describe('内置词表数据', () => {
  it('规模达到可用水平', () => {
    expect(DICT.length).toBeGreaterThanOrEqual(400);
  });

  it('每个词条都符合 schema', () => {
    for (const entry of DICT) {
      expect(entry.word, `word: ${JSON.stringify(entry.word)}`).toMatch(/^[a-z]+$/);
      expect(entry.pos, `pos of ${entry.word}`).toBeTruthy();
      expect(entry.gloss, `gloss of ${entry.word}`).toBeTruthy();
      expect(LEVELS).toContain(entry.level);
      expect([...entry.gloss].length, `gloss 长度 ${entry.word}`).toBeLessThanOrEqual(14);
      // 释义必须是中文，否则说明数据串行了
      expect(entry.gloss, `gloss 非中文 ${entry.word}`).toMatch(/[\u4e00-\u9fff]/);
      for (const alt of entry.alt ?? []) {
        expect(alt, `alt of ${entry.word}`).toMatch(/^[a-z]+$/);
      }
    }
  });

  it('词元唯一且已排序（便于人工 diff）', () => {
    const words = DICT.map((entry) => entry.word);
    expect(new Set(words).size).toBe(words.length);
    expect(words).toEqual([...words].sort());
  });

  it('每一档难度都有覆盖', () => {
    for (const level of LEVELS) {
      expect(DICT.filter((entry) => entry.level === level).length).toBeGreaterThan(0);
    }
  });

  it('alt 变体不与正式词条冲突', () => {
    const heads = new Set(DICT.map((entry) => entry.word));
    for (const entry of DICT) {
      for (const alt of entry.alt ?? []) {
        expect(heads.has(alt), `${alt} 既是 alt 又是头词`).toBe(false);
      }
    }
  });

  it('bundledEntries 返回副本，外部改动不会污染词表', () => {
    const first = bundledEntries();
    const second = bundledEntries();
    expect(first).not.toBe(second);
    expect(first.length).toBe(second.length);
  });
});

describe('OfflineDictionary', () => {
  const entries: DictEntry[] = [
    { word: 'child', pos: 'n.', gloss: '孩子', level: 'cet4', alt: ['children'] },
    { word: 'ubiquitous', pos: 'adj.', gloss: '无处不在的', level: 'gre' },
  ];

  it('精确命中并带上难度与词性', () => {
    const dict = new OfflineDictionary({ entries });
    const result = dict.lookupSync('ubiquitous');
    expect(result).toMatchObject({
      lemma: 'ubiquitous',
      gloss: '无处不在的',
      pos: 'adj.',
      level: 'gre',
      source: 'offline',
    });
  });

  it('alt 变体反查到同一词条', () => {
    const dict = new OfflineDictionary({ entries });
    expect(dict.lookupSync('children')?.lemma).toBe('child');
  });

  it('未收录返回 null', () => {
    const dict = new OfflineDictionary({ entries });
    expect(dict.lookupSync('nope')).toBeNull();
  });

  it('被禁用时 available 为 false 且不返回结果', () => {
    const dict = new OfflineDictionary({ entries, enabled: () => false });
    expect(dict.available()).toBe(false);
    expect(dict.lookupSync('child')).toBeNull();
  });

  it('异步接口与同步快路径结果一致', async () => {
    const dict = new OfflineDictionary({ entries });
    expect(await dict.lookup('child')).toEqual(dict.lookupSync('child'));
  });
});
