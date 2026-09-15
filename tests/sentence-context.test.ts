import { beforeEach, describe, expect, it } from 'vitest';
import { BlockIndex, blockOf } from '../src/content/sentence-context.js';
import { GlossRenderer } from '../src/content/gloss-renderer.js';
import { MAX_CONTEXT_CHARS } from '../src/core/sentence.js';
import type { LookupResult } from '../src/core/types.js';

const result = (lemma: string, gloss: string): LookupResult => ({
  lemma,
  surface: lemma,
  gloss,
  source: 'offline',
  at: 0,
});

function textNodeIn(html: string, needle: string): Text {
  document.body.innerHTML = html;
  const walker = document.createTreeWalker(document.body, 4);
  let node = walker.nextNode();
  while (node) {
    if ((node as Text).data.includes(needle)) return node as Text;
    node = walker.nextNode();
  }
  throw new Error(`夹具里找不到含「${needle}」的文本节点`);
}

describe('blockOf', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('找到最近的块级祖先，而不是 body', () => {
    document.body.innerHTML = '<div><p>text <b>here</b></p></div>';
    const bold = document.querySelector('b')!.firstChild!;
    expect(blockOf(bold)?.tagName).toBe('P');
  });

  it('内联元素不会被当成块', () => {
    document.body.innerHTML = '<p><span><em>x</em></span></p>';
    const em = document.querySelector('em')!.firstChild!;
    expect(blockOf(em)?.tagName).toBe('P');
  });
});

describe('取词所在的句子（DOM 版）', () => {
  let index: BlockIndex;

  beforeEach(() => {
    index = new BlockIndex();
    document.body.innerHTML = '';
  });

  it('句子跨多个行内元素时，取到的是完整句子而不是片段', () => {
    document.body.innerHTML =
      '<p>Other text here. The <b>engine</b> and the rudder drive great work.</p>';
    const node = textNodeIn(
      '<p>Other text here. The <b>engine</b> and the rudder drive great work.</p>',
      'engine',
    );
    const sentence = index.sentenceFor(node, 0);
    expect(sentence).toBe('The engine and the rudder drive great work.');
  });

  it('同一段落里的第二个词也能定位到自己那一句', () => {
    document.body.innerHTML =
      '<p>First sentence about engines. Second sentence about rudders and boats.</p>';
    const node = textNodeIn(document.body.innerHTML, 'rudders');
    const offset = node.data.indexOf('rudders');
    expect(index.sentenceFor(node, offset)).toBe(
      'Second sentence about rudders and boats.',
    );
  });

  it('已插入的中文释义不会污染上下文（这是必须排除的）', () => {
    document.body.innerHTML = '<p>The ubiquitous idea spreads widely across teams.</p>';
    const node = document.body.querySelector('p')!.firstChild as Text;

    // 先渲染一次，让段文本变成「The ubiquitous（无处不在的） idea spreads…」
    const renderer = new GlossRenderer();
    renderer.renderNode(
      node,
      [
        {
          token: { text: 'ubiquitous', start: 4, end: 14 },
          result: result('ubiquitous', '无处不在的'),
        },
      ],
      { showPos: false, style: 'subtle' },
    );
    expect(document.body.textContent).toContain('（无处不在的）');

    // 再找 idea 所在的文本节点（渲染后它是个新的文本节点）
    const ideaNode = textNodeIn(document.body.innerHTML, 'idea spreads');
    const fresh = new BlockIndex();
    const sentence = fresh.sentenceFor(ideaNode, ideaNode.data.indexOf('idea'));
    expect(sentence).toBe('The ubiquitous idea spreads widely across teams.');
    expect(sentence).not.toContain('（');
  });

  it('上下文里不含代码块的内容', () => {
    document.body.innerHTML =
      '<div><p>Real prose about engines here. <code>const engine = 1;</code></p></div>';
    const node = textNodeIn(document.body.innerHTML, 'Real prose');
    const sentence = index.sentenceFor(node, node.data.indexOf('engines'));
    expect(sentence).toBe('Real prose about engines here.');
  });

  it('拿不到偏移时返回 null，让调用方放弃这一项', () => {
    document.body.innerHTML = '<p>Some text here.</p>';
    const stray = document.createTextNode('detached');
    expect(index.sentenceFor(stray, 0)).toBeNull();
  });

  it('超长段落会裁剪到上限内', () => {
    const filler = Array.from({ length: 90 }, (_, i) => `word${i}`).join(' ');
    document.body.innerHTML = `<p>${filler} targetword sits here ${filler}.</p>`;
    const node = textNodeIn(document.body.innerHTML, 'targetword');
    const sentence = index.sentenceFor(node, node.data.indexOf('targetword'));
    expect(sentence).not.toBeNull();
    expect((sentence as string).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(sentence).toContain('targetword');
  });

  it('同一个块被反复询问时走缓存，结果一致', () => {
    document.body.innerHTML = '<p>Alpha sentence. Beta sentence with engine inside.</p>';
    const node = textNodeIn(document.body.innerHTML, 'engine');
    const offset = node.data.indexOf('engine');
    const first = index.sentenceFor(node, offset);
    const second = index.sentenceFor(node, offset);
    expect(first).toBe(second);
    expect(first).toBe('Beta sentence with engine inside.');
  });
});
