/**
 * 释义压缩的回归测试。
 *
 * `condenseGloss` 要把外部词库的完整释义（常 30–80 字）压成
 * wordmark 的 ≤14 字内联短释义。它有两条容易写错的规则，
 * 都是靠人工抽样才发现的，这里用测试钉住：
 *
 * 1. 尖括号语域标注要丢掉（`<美>住宿` 曾被压成 `美住宿`）；
 * 2. 括号在词中间时不能直接删（`在（船、飞机、火车等）上` 曾被压成 `在上`）。
 */

import { describe, expect, it } from 'vitest';
import { condenseGloss } from '../scripts/import-typewords.mjs';

describe('condenseGloss', () => {
  it('取第一个义项的第一小句', () => {
    expect(condenseGloss('取消（计划好的事情）；终止，废除；盖销，注销')).toBe('取消');
    expect(condenseGloss('易爆的，可能引起爆炸的；暴躁的，易怒的')).toBe('易爆的');
    expect(condenseGloss('能力，能够；才能，技能，本领')).toBe('能力');
  });

  it('丢掉尖括号语域标注', () => {
    expect(condenseGloss('<美>住宿，膳宿；<英>住处，办公处')).toBe('住宿');
    expect(condenseGloss('<正式> 广为流传的')).toBe('广为流传的');
  });

  it('丢掉方括号与中文方括号标注', () => {
    expect(condenseGloss('[计]取消；删去')).toBe('取消');
    expect(condenseGloss('【名】康塞尔')).toBe('康塞尔');
  });

  it('开头的括号整体丢弃（多是词性补充）', () => {
    expect(condenseGloss('（使）加快，促进')).toBe('加快');
    expect(condenseGloss('（隐隐地、持续地）疼痛；渴望')).toBe('疼痛');
  });

  it('中间的括号保留内容，避免留下残句', () => {
    // 曾经的 bug：直接删括号会得到「在上」
    expect(condenseGloss('在（船、飞机、火车等）上；上（船、飞机、火车等）')).toBe(
      '在船、飞机、火车等上',
    );
    expect(condenseGloss('使（某人）熟悉，使了解')).toBe('使某人熟悉');
  });

  it('结尾的括号是补充说明，丢掉更干净', () => {
    expect(condenseGloss('取消（计划好的事情）；终止，废除')).toBe('取消');
  });

  it('括号内的逗号不当作分句边界', () => {
    expect(condenseGloss('在（船、飞机、火车等）上，在途中的；')).toBe('在船、飞机、火车等上');
  });

  it('保留中文顿号，读起来更清楚', () => {
    expect(condenseGloss('苹果、梨等水果')).toBe('苹果、梨等水果');
  });

  it('超过 14 字会被截断', () => {
    const long = '这是一个非常长的释义需要被截断处理掉多余的部分';
    const gloss = condenseGloss(long);
    expect([...gloss].length).toBe(14);
    expect(long.startsWith(gloss)).toBe(true);
  });

  it('压不出中文就返回 null（英文释义 / 空值 / 非字符串）', () => {
    expect(condenseGloss('a type of small animal')).toBeNull();
    expect(condenseGloss('')).toBeNull();
    expect(condenseGloss('   ')).toBeNull();
    expect(condenseGloss(null)).toBeNull();
    expect(condenseGloss(undefined)).toBeNull();
    expect(condenseGloss({ cn: '取消' })).toBeNull();
    expect(condenseGloss('123 456')).toBeNull();
  });

  it('结果一定不含英文、数字与括号', () => {
    const samples = [
      'vt. 取消（计划好的事情）；终止',
      '<英>住处，办公处（楼房内的）空间',
      '[化] 爆炸物；炸药',
      '   空格很多的释义   ',
    ];
    for (const sample of samples) {
      const gloss = condenseGloss(sample);
      if (gloss === null) continue;
      expect(gloss).toMatch(/^[\u4e00-\u9fff、]+$/);
      expect([...gloss].length).toBeLessThanOrEqual(14);
    }
  });
});
