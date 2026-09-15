import { describe, expect, it } from 'vitest';
import { MAX_CONTEXT_CHARS, sentenceAt, sentenceSpans } from '../src/core/sentence.js';

describe('保留偏移的切句', () => {
  it('偏移能原样切回句子（这是改 DOM 的前提）', () => {
    const text = 'First one here. Second one there! Third one? Done.';
    const spans = sentenceSpans(text);
    expect(spans.map((span) => span.text)).toEqual([
      'First one here.',
      'Second one there!',
      'Third one?',
      'Done.',
    ]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it('句末的右引号要跟着前一句，不能留给下一句', () => {
    const text = 'He said "I am done." Then he left the room quietly.';
    const spans = sentenceSpans(text);
    expect(spans.map((span) => span.text)).toEqual([
      'He said "I am done."',
      'Then he left the room quietly.',
    ]);
  });

  it('换行是硬边界（DOM 的 textContent 里 <br> 会留下换行）', () => {
    const text = 'A heading without end punctuation\nA following paragraph starts here.';
    const spans = sentenceSpans(text);
    expect(spans.map((span) => span.text)).toEqual([
      'A heading without end punctuation',
      'A following paragraph starts here.',
    ]);
  });

  it('小数点、缩写、小写续句都不该切', () => {
    const text = 'The value is 3.14 and it stays. See e.g. this example here.';
    const spans = sentenceSpans(text);
    expect(spans.map((span) => span.text)).toEqual([
      'The value is 3.14 and it stays.',
      'See e.g. this example here.',
    ]);
  });

  it('首尾空白不会进入 span，但偏移仍然对齐原文', () => {
    const text = '   Leading space.   Trailing space.   ';
    const spans = sentenceSpans(text);
    expect(spans.map((span) => span.text)).toEqual(['Leading space.', 'Trailing space.']);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });
});

describe('定位词所在的句子', () => {
  const text = 'This is the first sentence about engines. The engine and the rudder drive great work forward.';

  it('返回包含该偏移的句子，且偏移与原文一致', () => {
    const offset = text.indexOf('rudder');
    const span = sentenceAt(text, offset);
    expect(span?.text).toBe('The engine and the rudder drive great work forward.');
    expect(text.slice(span?.start, span?.end)).toBe(span?.text);
    // 目标词确实落在返回区间内
    expect(offset).toBeGreaterThanOrEqual(span?.start ?? 0);
    expect(offset).toBeLessThan(span?.end ?? 0);
  });

  it('偏移落在句子之间的空白时返回前一句', () => {
    const between = text.indexOf('. ') + 1; // 句号后的空格
    const span = sentenceAt(text, between);
    expect(span?.text).toBe('This is the first sentence about engines.');
  });

  it('偏移越界时收敛到首句 / 末句，而不是抛错', () => {
    expect(sentenceAt(text, -5)?.text).toBe('This is the first sentence about engines.');
    expect(sentenceAt(text, 99_999)?.text).toBe(
      'The engine and the rudder drive great work forward.',
    );
  });

  it('空文本返回 null，调用方据此放弃这一项', () => {
    expect(sentenceAt('', 0)).toBeNull();
    expect(sentenceAt('    ', 1)).toBeNull();
  });

  it('超长句按目标词为中心裁剪，不超上限且不切碎词', () => {
    const filler = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ');
    const long = `${filler} the targetword sits right here ${filler}.`;
    const offset = long.indexOf('targetword');
    const span = sentenceAt(long, offset);
    expect(span).not.toBeNull();
    expect(span?.text.length ?? 0).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    // 裁剪后目标词仍在上下文里
    expect(span?.text).toContain('targetword');
    // 裁剪边界不应该把词切一半：不应以半个 wordN 开头/结尾
    expect(span?.text.startsWith('ord')).toBe(false);
  });

  it('刚好在上限内的句子原样返回', () => {
    const sentence = 'A short sentence with an engine inside it.';
    const span = sentenceAt(sentence, sentence.indexOf('engine'));
    expect(span?.text).toBe(sentence);
    expect(span?.start).toBe(0);
    expect(span?.end).toBe(sentence.length);
  });
});
