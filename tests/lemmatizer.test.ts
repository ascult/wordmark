import { describe, expect, it } from 'vitest';
import { lemmaCandidates } from '../src/core/lemmatizer.js';

/** 断言 raw 的候选里包含 expected（顺序无关，只关心能不能命中）。 */
function includes(raw: string, expected: string): void {
  expect(lemmaCandidates(raw)).toContain(expected);
}

describe('lemmaCandidates', () => {
  it('第一个候选永远是原词小写形式（精确命中优先）', () => {
    expect(lemmaCandidates('Running')[0]).toBe('running');
  });

  it('名词复数', () => {
    includes('books', 'book');
    includes('boxes', 'box');
    includes('studies', 'study');
    includes('knives', 'knife');
  });

  it('动词变形', () => {
    includes('running', 'run');
    includes('stopped', 'stop');
    includes('making', 'make');
    includes('created', 'create');
    includes('carried', 'carry');
  });

  it('比较级与副词', () => {
    includes('larger', 'large');
    includes('biggest', 'big');
    includes('quickly', 'quick');
    includes('happily', 'happy');
  });

  it('派生名词回退到词根', () => {
    includes('creation', 'create');
    includes('organisation', 'organise');
    includes('movement', 'move');
    includes('darkness', 'dark');
  });

  it('高频不规则形式', () => {
    includes('children', 'child');
    includes('went', 'go');
    includes('written', 'write');
    includes('better', 'good');
    includes('criteria', 'criterion');
  });

  it('所有格与缩写先剥后缀', () => {
    includes("reader's", 'reader');
    includes("don't", 'don');
  });

  it('不产生过短的候选', () => {
    for (const candidate of lemmaCandidates('is')) {
      expect(candidate.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('候选去重', () => {
    const candidates = lemmaCandidates('studies');
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});
