import { beforeEach, describe, expect, it } from 'vitest';
import { GlossRenderer, formatGloss } from '../src/content/gloss-renderer.js';
import { MARK_CLASS, MARK_SELECTOR } from '../src/content/constants.js';
import type { LookupResult } from '../src/core/types.js';

const result = (lemma: string, gloss: string, extra: Partial<LookupResult> = {}): LookupResult => ({
  lemma,
  surface: lemma,
  gloss,
  source: 'offline',
  at: 0,
  ...extra,
});

const options = { showPos: false, style: 'subtle' as const };

function textNodeOf(html: string): Text {
  document.body.innerHTML = html;
  const node = document.body.firstChild?.firstChild;
  if (!node || node.nodeType !== 3) throw new Error('测试夹具不是文本节点');
  return node as Text;
}

describe('formatGloss', () => {
  it('默认只输出括号释义', () => {
    expect(formatGloss(result('child', '孩子'), false)).toBe('（孩子）');
  });

  it('开启词性后带上词性', () => {
    expect(formatGloss(result('child', '孩子', { pos: 'n.' }), true)).toBe('（n.孩子）');
  });

  it('没有词性信息时不产生空标记', () => {
    expect(formatGloss(result('child', '孩子'), true)).toBe('（孩子）');
  });
});

describe('GlossRenderer', () => {
  let renderer: GlossRenderer;

  beforeEach(() => {
    renderer = new GlossRenderer();
    document.body.innerHTML = '';
  });

  it('渲染后原文完整保留，只在词后追加释义', () => {
    const node = textNodeOf('<p>The ubiquitous idea spreads.</p>');
    const count = renderer.renderNode(
      node,
      [{ token: { text: 'ubiquitous', start: 4, end: 14 }, result: result('ubiquitous', '无处不在的') }],
      options,
    );
    expect(count).toBe(1);
    expect(document.body.textContent).toBe('The ubiquitous（无处不在的） idea spreads.');
    expect(renderer.count).toBe(1);
    expect(renderer.uniqueCount).toBe(1);
  });

  it('同一节点多处标注按偏移正确拼接', () => {
    const node = textNodeOf('<p>alpha beta gamma</p>');
    renderer.renderNode(
      node,
      [
        { token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') },
        { token: { text: 'gamma', start: 11, end: 16 }, result: result('gamma', '丙') },
      ],
      options,
    );
    expect(document.body.textContent).toBe('alpha（甲） beta gamma（丙）');
    expect(renderer.count).toBe(2);
  });

  it('标注节点带有词元属性，供点击与统计使用', () => {
    const node = textNodeOf('<p>ubiquitous</p>');
    renderer.renderNode(
      node,
      [{ token: { text: 'ubiquitous', start: 0, end: 10 }, result: result('ubiquitous', '无处不在的') }],
      options,
    );
    const mark = document.querySelector(MARK_SELECTOR);
    expect(mark?.getAttribute('data-wordmark-lemma')).toBe('ubiquitous');
    expect(mark?.getAttribute('data-wordmark-source')).toBe('offline');
    expect(mark?.classList.contains(MARK_CLASS)).toBe(true);
  });

  it('重叠区间被防御性跳过，不破坏文本', () => {
    const node = textNodeOf('<p>abcdef</p>');
    renderer.renderNode(
      node,
      [
        { token: { text: 'abcd', start: 0, end: 4 }, result: result('abcd', '甲') },
        { token: { text: 'cdef', start: 2, end: 6 }, result: result('cdef', '乙') },
      ],
      options,
    );
    expect(document.body.textContent).toBe('abcd（甲）ef');
    expect(renderer.count).toBe(1);
  });

  it('越界区间不会抛错', () => {
    const node = textNodeOf('<p>abc</p>');
    expect(() =>
      renderer.renderNode(
        node,
        [{ token: { text: 'abc', start: 0, end: 99 }, result: result('abc', '甲') }],
        options,
      ),
    ).not.toThrow();
    expect(renderer.count).toBe(0);
  });

  it('空匹配列表不改变 DOM', () => {
    const node = textNodeOf('<p>abc</p>');
    expect(renderer.renderNode(node, [], options)).toBe(0);
    expect(document.body.innerHTML).toBe('<p>abc</p>');
  });

  it('removeLemma 只移除指定词元', () => {
    const node = textNodeOf('<p>alpha beta</p>');
    renderer.renderNode(
      node,
      [
        { token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') },
        { token: { text: 'beta', start: 6, end: 10 }, result: result('beta', '乙') },
      ],
      options,
    );
    expect(renderer.removeLemma('alpha')).toBe(1);
    expect(document.body.textContent).toBe('alpha beta（乙）');
    expect(renderer.count).toBe(1);
    expect(renderer.removeLemma('missing')).toBe(0);
  });

  it('unmarkAll 精确还原原始文本节点', () => {
    const original = 'The ubiquitous idea spreads across children.';
    const node = textNodeOf(`<p>${original}</p>`);
    renderer.renderNode(node, [
      { token: { text: 'ubiquitous', start: 4, end: 14 }, result: result('ubiquitous', '无处不在的') },
      {
        token: { text: 'children', start: 36, end: 44 },
        result: result('children', '孩子们', { lemma: 'child' }),
      },
    ], options);
    expect(renderer.count).toBe(2);

    renderer.unmarkAll(document);
    expect(renderer.count).toBe(0);
    expect(document.querySelectorAll(MARK_SELECTOR)).toHaveLength(0);
    expect(document.body.textContent).toBe(original);
    // normalize() 之后应还原成单个文本节点
    expect(document.querySelector('p')?.childNodes).toHaveLength(1);
  });

  it('isOwn 能识别渲染器创建的节点', () => {
    const node = textNodeOf('<p>alpha</p>');
    renderer.renderNode(node, [{ token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') }], options);
    const mark = document.querySelector(MARK_SELECTOR)!;
    expect(renderer.isOwn(mark)).toBe(true);
    expect(renderer.isOwn(mark.firstChild!)).toBe(true);
    expect(renderer.isOwn(document.body)).toBe(false);
  });

  it('节点已脱离文档时不渲染', () => {
    const node = document.createTextNode('detached word');
    expect(renderer.renderNode(node, [{ token: { text: 'detached', start: 0, end: 8 }, result: result('detached', '分离的') }], options)).toBe(0);
  });

  it('词性样式通过 wrapper 类名区分', () => {
    const node = textNodeOf('<p>alpha</p>');
    renderer.renderNode(node, [{ token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') }], {
      showPos: true,
      style: 'boxed',
    });
    expect(document.querySelector(MARK_SELECTOR)?.className).toContain('wordmark-gloss--boxed');
  });
});

describe('按处更新释义（语境义回填）', () => {
  let renderer: GlossRenderer;

  beforeEach(() => {
    renderer = new GlossRenderer();
    document.body.innerHTML = '';
  });

  it('onGloss 每处回调一次，matchIndex 指回调用方的 matches 下标', () => {
    const node = textNodeOf('<p>alpha beta gamma</p>');
    const seen: Array<{ id: number; lemma: string; matchIndex: number }> = [];
    renderer.renderNode(
      node,
      [
        { token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') },
        { token: { text: 'gamma', start: 11, end: 16 }, result: result('gamma', '丙') },
      ],
      { ...options, onGloss: (gloss) => seen.push(gloss) },
    );
    expect(seen).toHaveLength(2);
    expect(seen.map((item) => item.lemma)).toEqual(['alpha', 'gamma']);
    // 顺序按文档位置，但下标必须是调用方数组里的原始下标
    expect(seen.map((item) => item.matchIndex)).toEqual([0, 1]);
    expect(new Set(seen.map((item) => item.id)).size).toBe(2);
  });

  it('同一词的两处可以拿到不同的义项（这是逐处更新的意义）', () => {
    const node = textNodeOf('<p>engine runs. engine drives.</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [
        { token: { text: 'engine', start: 0, end: 6 }, result: result('engine', '发动机') },
        { token: { text: 'engine', start: 13, end: 19 }, result: result('engine', '发动机') },
      ],
      { ...options, onGloss: (gloss) => ids.push(gloss.id) },
    );
    expect(ids).toHaveLength(2);
    expect(renderer.updateGlossText(ids[0]!, '发动机/引擎')).toBe(true);
    expect(renderer.updateGlossText(ids[1]!, '驱动力/推动力')).toBe(true);
    expect(document.body.textContent).toBe('engine（发动机/引擎） runs. engine（驱动力/推动力） drives.');
  });

  it('更新时保留词性前缀', () => {
    const node = textNodeOf('<p>engine</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [{ token: { text: 'engine', start: 0, end: 6 }, result: result('engine', '发动机', { pos: 'n.' }) }],
      { showPos: true, style: 'subtle', onGloss: (gloss) => ids.push(gloss.id) },
    );
    expect(document.body.textContent).toBe('engine（n.发动机）');
    renderer.updateGlossText(ids[0]!, '驱动力/推动力');
    expect(document.body.textContent).toBe('engine（n.驱动力/推动力）');
  });

  it('未知 id 返回 false，不抛错', () => {
    expect(renderer.updateGlossText(999, '无')).toBe(false);
  });

  it('标注被移除后更新是安全的空操作', () => {
    const node = textNodeOf('<p>alpha</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [{ token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') }],
      { ...options, onGloss: (gloss) => ids.push(gloss.id) },
    );
    renderer.removeLemma('alpha');
    expect(document.body.textContent).toBe('alpha');
    expect(renderer.updateGlossText(ids[0]!, '乙')).toBe(false);
  });

  it('unmarkAll 之后更新同样是空操作', () => {
    const node = textNodeOf('<p>alpha</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [{ token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') }],
      { ...options, onGloss: (gloss) => ids.push(gloss.id) },
    );
    renderer.unmarkAll(document);
    expect(renderer.updateGlossText(ids[0]!, '乙')).toBe(false);
  });

  it('glossTextOf 能读回当前释义（去掉括号与词性）', () => {
    const node = textNodeOf('<p>engine</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [{ token: { text: 'engine', start: 0, end: 6 }, result: result('engine', '发动机', { pos: 'n.' }) }],
      { showPos: true, style: 'subtle', onGloss: (gloss) => ids.push(gloss.id) },
    );
    expect(renderer.glossTextOf(ids[0]!)).toBe('发动机');
    renderer.updateGlossText(ids[0]!, '驱动力');
    expect(renderer.glossTextOf(ids[0]!)).toBe('驱动力');
    expect(renderer.glossTextOf(999)).toBeNull();
  });

  it('wrapper 上带 id 属性，便于从 DOM 反查', () => {
    const node = textNodeOf('<p>alpha</p>');
    const ids: number[] = [];
    renderer.renderNode(
      node,
      [{ token: { text: 'alpha', start: 0, end: 5 }, result: result('alpha', '甲') }],
      { ...options, onGloss: (gloss) => ids.push(gloss.id) },
    );
    const wrapper = document.querySelector(MARK_SELECTOR);
    expect(wrapper?.getAttribute('data-wordmark-gloss-id')).toBe(String(ids[0]));
  });
});
