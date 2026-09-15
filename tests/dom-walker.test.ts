import { beforeEach, describe, expect, it } from 'vitest';
import { DomWalker } from '../src/content/dom-walker.js';

function collect(html: string, options?: ConstructorParameters<typeof DomWalker>[1]): string[] {
  document.body.innerHTML = html;
  const walker = new DomWalker(document.body, options);
  return walker.collect(document.body).map((node) => node.data);
}

describe('DomWalker.collect', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('收集正文文本节点，按文档顺序', () => {
    expect(collect('<p>First para</p><div>Second <b>bold</b></div>')).toEqual([
      'First para',
      'Second ',
      'bold',
    ]);
  });

  it('跳过不含字母的节点', () => {
    expect(collect('<p>123 45</p><p>中文内容</p><p>real words</p>')).toEqual(['real words']);
  });

  it('跳过脚本、样式与模板', () => {
    const html = `
      <script>const secret = 'visible';</script>
      <style>.a { content: "hidden"; }</style>
      <noscript>no script text</noscript>
      <template>template text</template>
      <p>body text</p>`;
    expect(collect(html)).toEqual(['body text']);
  });

  it('跳过代码块（技术文章里最重要的一条）', () => {
    const html = `
      <p>Use the <code>addEventListener</code> API</p>
      <pre><span>const value = compute();</span></pre>
      <kbd>Ctrl</kbd><samp>output</samp><var>variable</var>`;
    expect(collect(html)).toEqual(['Use the ', ' API']);
  });

  it('跳过表单控件与按钮', () => {
    const html = `
      <input value="placeholder text" />
      <textarea>textarea content</textarea>
      <select><option>option text</option></select>
      <button>button label</button>
      <p>paragraph text</p>`;
    expect(collect(html)).toEqual(['paragraph text']);
  });

  it('跳过可编辑区域', () => {
    const html = `
      <div contenteditable="true">editable content</div>
      <div contenteditable="">plaintext only</div>
      <p>read only text</p>`;
    expect(collect(html)).toEqual(['read only text']);
  });

  it('跳过 aria-hidden、hidden 与 translate=no', () => {
    const html = `
      <span aria-hidden="true">decorative text</span>
      <span hidden>hidden text</span>
      <span translate="no">brand name</span>
      <span class="notranslate">brand name too</span>
      <p>visible text</p>`;
    expect(collect(html)).toEqual(['visible text']);
  });

  it('跳过 display:none / visibility:hidden 的内容', () => {
    const html = `
      <p style="display:none">display none text</p>
      <p style="visibility:hidden">invisible text</p>
      <p>visible text</p>`;
    expect(collect(html)).toEqual(['visible text']);
  });

  it('跳过自己注入的标注，避免二次处理', () => {
    const html = `
      <p>before <span data-wordmark="1">ubiquitous<span data-wordmark="1">（无处不在的）</span></span> after</p>`;
    expect(collect(html)).toEqual(['before ', ' after']);
  });

  it('可关闭可见性检查（单测/特殊场景）', () => {
    expect(collect('<p style="display:none">hidden text</p>', { checkVisibility: false })).toEqual([
      'hidden text',
    ]);
  });

  it('支持自定义额外忽略选择器', () => {
    expect(
      collect('<div class="ad">sponsored words</div><p>content text</p>', {
        extraSkipSelector: '.ad',
      }),
    ).toEqual(['content text']);
  });

  it('isTextCandidate 与 collect 判定一致', () => {
    document.body.innerHTML = '<p>good text</p><code>not code</code>';
    const walker = new DomWalker(document.body);
    const collected = walker.collect(document.body);
    expect(collected).toHaveLength(1);
    expect(walker.isTextCandidate(collected[0]!)).toBe(true);
  });

  it('collect 可以只处理子树（动态内容场景）', () => {
    document.body.innerHTML = '<div id="root"><p>inside text</p></div><p>outside text</p>';
    const walker = new DomWalker(document.body);
    const root = document.getElementById('root');
    expect(walker.collect(root!).map((node) => node.data)).toEqual(['inside text']);
  });
});
