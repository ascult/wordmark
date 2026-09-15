import { describe, expect, it } from 'vitest';
import { RepeatTracker, isHardEnough, shouldAnnotate } from '../src/core/annotator.js';
import { LEVEL_RANK, LEVELS } from '../src/core/types.js';

describe('isHardEnough', () => {
  it('难度等级是「下限」语义：达到阈值即标注', () => {
    expect(isHardEnough('cet4', 'cet4')).toBe(true);
    expect(isHardEnough('cet6', 'cet4')).toBe(true);
    expect(isHardEnough('gre', 'ielts')).toBe(true);
  });

  it('basic 档是最低一级：只有把生词线调到 basic 才会被标注', () => {
    expect(isHardEnough('basic', 'basic')).toBe(true);
    expect(isHardEnough('basic', 'cet4')).toBe(false);
  });

  it('低于阈值的词视为已知，跳过', () => {
    expect(isHardEnough('cet4', 'cet6')).toBe(false);
    expect(isHardEnough('ielts', 'gre')).toBe(false);
  });

  it('没有等级信息（在线结果）时不过滤', () => {
    expect(isHardEnough(undefined, 'gre')).toBe(true);
  });

  it('等级排序是全序，保证比较稳定', () => {
    const ranks = LEVELS.map((level) => LEVEL_RANK[level]);
    expect(new Set(ranks).size).toBe(LEVELS.length);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe('shouldAnnotate', () => {
  const policy = { annotateFrom: 'cet4' as const, knownWords: new Set(['child']) };

  it('已知词优先于难度判断', () => {
    expect(shouldAnnotate('child', 'gre', policy)).toBe(false);
  });

  it('未收录难度信息时按阈值放行', () => {
    expect(shouldAnnotate('ubiquitous', undefined, policy)).toBe(true);
  });

  it('词表里没有的词在难度不足时不标注', () => {
    expect(shouldAnnotate('book', 'cet4', { annotateFrom: 'ielts', knownWords: new Set() })).toBe(
      false,
    );
  });
});

describe('RepeatTracker', () => {
  it('first 模式：每个词元只放行一次', () => {
    const tracker = new RepeatTracker('first');
    expect(tracker.allows('child')).toBe(true);
    tracker.note('child');
    expect(tracker.allows('child')).toBe(false);
    expect(tracker.count('child')).toBe(1);
    expect(tracker.allows('other')).toBe(true);
  });

  it('all 模式：每次都放行', () => {
    const tracker = new RepeatTracker('all');
    tracker.note('child');
    tracker.note('child');
    expect(tracker.allows('child')).toBe(true);
    expect(tracker.count('child')).toBe(2);
  });

  it('注意发生在渲染前也计入，避免同批重复标注', () => {
    const tracker = new RepeatTracker('first');
    // pipeline 在生成 matches 时就 note，因此同一批里的第二次出现会被挡住。
    tracker.note('child');
    expect(tracker.allows('child')).toBe(false);
  });
});
