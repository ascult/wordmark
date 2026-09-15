import { describe, expect, it } from 'vitest';
import {
  isCandidateToken,
  normalizeToken,
  stripClitics,
  tokenize,
} from '../src/core/tokenizer.js';

describe('tokenize', () => {
  it('切出词元并保留原始偏移', () => {
    const tokens = tokenize('The quick brown fox');
    expect(tokens.map((token) => token.text)).toEqual(['The', 'quick', 'brown', 'fox']);
    expect(tokens[0]).toEqual({ text: 'The', start: 0, end: 3 });
    expect(tokens[3]).toEqual({ text: 'fox', start: 16, end: 19 });
  });

  it('把连字符拆成两个独立词，而不是一个复合词', () => {
    expect(tokenize('well-known').map((token) => token.text)).toEqual(['well', 'known']);
  });

  it('保留词内撇号（含全角撇号）', () => {
    expect(tokenize("don't stop").map((token) => token.text)).toEqual(["don't", 'stop']);
    expect(tokenize('it\u2019s fine').map((token) => token.text)).toEqual(['it\u2019s', 'fine']);
  });

  it('忽略数字与 CJK，只取英文', () => {
    expect(tokenize('第 3 章 chapter 里有 2 words').map((token) => token.text)).toEqual([
      'chapter',
      'words',
    ]);
  });

  it('重复调用不会受正则 lastIndex 影响', () => {
    expect(tokenize('alpha beta')).toEqual(tokenize('alpha beta'));
  });

  it('偏移量能精确切回原文', () => {
    const text = 'A ubiquitous idea, truly.';
    for (const token of tokenize(text)) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
  });
});

describe('isCandidateToken', () => {
  const options = { minWordLength: 3 };

  it('按最短词长过滤', () => {
    expect(isCandidateToken('of', options)).toBe(false);
    expect(isCandidateToken('the', options)).toBe(true);
  });

  it('撇号不计入词长', () => {
    // "it's" 实际只有 3 个字母
    expect(isCandidateToken("it's", { minWordLength: 4 })).toBe(false);
    expect(isCandidateToken("it's", { minWordLength: 3 })).toBe(true);
  });

  it('跳过缩写与驼峰标识符', () => {
    expect(isCandidateToken('HTTP', options)).toBe(false);
    expect(isCandidateToken('NASA', options)).toBe(false);
    expect(isCandidateToken('iPhone', options)).toBe(false);
    expect(isCandidateToken('WordPress', options)).toBe(false);
  });
});

describe('normalizeToken / stripClitics', () => {
  it('统一撇号并转小写', () => {
    expect(normalizeToken('Don\u2019t')).toBe("don't");
  });

  it('剥离所有格与缩写后缀', () => {
    expect(stripClitics("reader's")).toBe('reader');
    expect(stripClitics("don't")).toBe('don');
    expect(stripClitics('plain')).toBe('plain');
  });
});
