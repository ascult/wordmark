import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepeatTracker } from '../src/core/annotator.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.js';
import type { DictEntry } from '../src/core/types.js';
import { DomWalker } from '../src/content/dom-walker.js';
import { GlossRenderer } from '../src/content/gloss-renderer.js';
import { AnnotationPipeline } from '../src/content/pipeline.js';
import { OfflineDictionary } from '../src/dict/offline.js';
import { DictionaryRegistry } from '../src/dict/registry.js';

const ENTRIES: DictEntry[] = [
  { word: 'child', pos: 'n.', gloss: '孩子', level: 'cet4', alt: ['children'] },
  { word: 'ubiquitous', pos: 'adj.', gloss: '无处不在的', level: 'gre' },
  { word: 'scrutinise', pos: 'v.', gloss: '审查', level: 'ielts' },
];

function harness(overrides: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  const registry = new DictionaryRegistry().addLocal(
    new OfflineDictionary({ entries: ENTRIES }),
  );
  const renderer = new GlossRenderer();
  let walker = new DomWalker(document.body);
  const knownWords = new Set<string>();
  const unresolved = new Set<string>();
  let repeat = new RepeatTracker(settings.repeatMode);

  const pipeline = new AnnotationPipeline({
    registry,
    renderer,
    walker: () => walker,
    settings: () => settings,
    knownWords: () => knownWords,
    repeat: () => repeat,
    unresolved,
    // 测试里不需要真的让出主线程
    yieldControl: async () => {},
  });

  return {
    settings,
    renderer,
    get walker() {
      return walker;
    },
    knownWords,
    unresolved,
    pipeline,
    registry,
    /** 模拟设置变更后的全量重扫：换一个干净的 walker（缓存失效）。 */
    rescan: async () => {
      renderer.unmarkAll(document);
      walker = new DomWalker(document.body);
      repeat = new RepeatTracker(settings.repeatMode);
      await pipeline.processNodes(walker.collect(document.body));
    },
    resetRepeat: () => {
      repeat = new RepeatTracker(settings.repeatMode);
    },
  };
}

async function run(html: string, overrides: Partial<Settings> = {}) {
  document.body.innerHTML = html;
  const ctx = harness(overrides);
  await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
  return ctx;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('AnnotationPipeline 端到端', () => {
  it('给正文里的生词就地插入中文释义', async () => {
    const ctx = await run('<p>The ubiquitous idea frightens children.</p>');
    expect(document.body.textContent).toBe(
      'The ubiquitous（无处不在的） idea frightens children（孩子）.',
    );
    expect(ctx.renderer.count).toBe(2);
    expect(ctx.renderer.uniqueCount).toBe(2);
  });

  it('跨多个段落与行内标签都能标注', async () => {
    await run('<p>An <b>ubiquitous</b> signal.</p><p>Please scrutinise it.</p>');
    expect(document.body.textContent).toContain('ubiquitous（无处不在的）');
    expect(document.body.textContent).toContain('scrutinise（审查）');
  });

  it('不碰代码块、输入框与可编辑区', async () => {
    const ctx = await run(
      '<p>ubiquitous</p><code>ubiquitous</code><pre>scrutinise</pre>' +
        '<textarea>ubiquitous</textarea><div contenteditable="true">scrutinise</div>',
    );
    expect(ctx.renderer.count).toBe(1);
    expect(document.querySelector('code')?.textContent).toBe('ubiquitous');
    expect(document.querySelector('pre')?.textContent).toBe('scrutinise');
  });

  it('生词线过滤掉较简单的词', async () => {
    const ctx = await run('<p>children are ubiquitous</p>', { annotateFrom: 'gre' });
    // children 是 cet4，被阈值挡掉；ubiquitous 是 gre，保留
    expect(ctx.renderer.count).toBe(1);
    expect(document.body.textContent).toContain('ubiquitous（无处不在的）');
    expect(document.body.textContent).toContain('children are');
  });

  it('已知词表抑制标注', async () => {
    document.body.innerHTML = '<p>children and ubiquitous</p>';
    const ctx = harness();
    ctx.knownWords.add('ubiquitous');
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    expect(ctx.renderer.count).toBe(1);
    expect(document.body.textContent).not.toContain('（无处不在的）');
    expect(document.body.textContent).toContain('children（孩子）');
  });

  it('repeatMode=first：同页同一个词只标一次', async () => {
    const ctx = await run('<p>ubiquitous and ubiquitous and ubiquitous</p>');
    expect(ctx.renderer.count).toBe(1);
  });

  it('repeatMode=all：每次出现都标注', async () => {
    const ctx = await run('<p>ubiquitous and ubiquitous</p>', { repeatMode: 'all' });
    expect(ctx.renderer.count).toBe(2);
  });

  it('最短词长过滤生效', async () => {
    const ctx = await run('<p>a child is here</p>', { minWordLength: 6 });
    expect(ctx.renderer.count).toBe(0);
  });

  it('单页上限会截断标注数量', async () => {
    const paragraph = 'ubiquitous '.repeat(30);
    const ctx = await run(`<p>${paragraph}</p>`, { maxGlossesPerPage: 20, repeatMode: 'all' });
    expect(ctx.renderer.count).toBe(20);
    expect(ctx.renderer.count).toBeLessThanOrEqual(20);
  });

  it('记录词典未收录的词，供弹窗展示', async () => {
    const ctx = await run('<p>ubiquitous zzzunknown</p>');
    expect(ctx.unresolved.has('zzzunknown')).toBe(true);
    expect(ctx.unresolved.has('ubiquitous')).toBe(false);
  });

  it('重复处理是幂等的，不会二次包裹已标注的词', async () => {
    const ctx = harness();
    document.body.innerHTML = '<p>ubiquitous ideas</p>';
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    const first = ctx.renderer.count;
    // 模拟观察器把同一批文本再次交上来
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    expect(ctx.renderer.count).toBe(first);
    expect(document.querySelectorAll('[data-wordmark-lemma]')).toHaveLength(1);
  });

  it('unmarkAll 之后重扫能重新标满整页（回归：不能跳过自己创建的文本节点）', async () => {
    // 真浏览器里发现过这个 bug：第一次渲染后，正文的大部分文本已经存在于
    // 渲染器自己创建的「间隙」文本节点里。重扫时若按 isOwn 跳过它们，
    // 每重扫一次标注就会少一大截（实测 410 → 9 → 3）。
    const html = '<p>The ubiquitous idea frightens children and children.</p>';
    document.body.innerHTML = html;
    const ctx = harness();
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    const first = ctx.renderer.count;
    expect(first).toBeGreaterThan(0);

    await ctx.rescan();
    expect(ctx.renderer.count).toBe(first);
    expect(document.body.textContent).toContain('ubiquitous（无处不在的）');

    // 再来一次，确保不会逐次衰减
    await ctx.rescan();
    expect(ctx.renderer.count).toBe(first);
  });

  it('unmarkAll 之后 DOM 完全回到原文', async () => {
    const original = 'The ubiquitous idea frightens children.';
    const ctx = harness();
    document.body.innerHTML = `<p>${original}</p>`;
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    expect(document.body.textContent).not.toBe(original);

    ctx.renderer.unmarkAll(document);
    expect(document.body.textContent).toBe(original);
    expect(document.querySelectorAll('[data-wordmark]')).toHaveLength(0);
  });

  it('释义文本按纯文本渲染，永远不会变成 HTML（XSS 回归）', async () => {
    document.body.innerHTML = '<p>dangerous</p>';
    const ctx = harness();
    const registry = new DictionaryRegistry().addLocal(
      new OfflineDictionary({
        entries: [{ word: 'dangerous', pos: 'adj.', gloss: '<img src=x onerror=alert(1)>', level: 'cet4' }],
      }),
    );
    const renderer = new GlossRenderer();
    const pipeline = new AnnotationPipeline({
      registry,
      renderer,
      walker: () => ctx.walker,
      settings: () => ctx.settings,
      knownWords: () => new Set(),
      repeat: () => new RepeatTracker('all'),
      yieldControl: async () => {},
    });
    await pipeline.processNodes(ctx.walker.collect(document.body));

    expect(document.querySelector('img')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('动态追加的子树可以单独处理', async () => {
    const ctx = await run('<p>ubiquitous</p>');
    expect(ctx.renderer.count).toBe(1);

    const added = document.createElement('div');
    added.innerHTML = '<p>Please scrutinise children.</p>';
    document.body.appendChild(added);
    await ctx.pipeline.processNodes(ctx.walker.collect(added));
    expect(ctx.renderer.count).toBe(3);
  });

  it('同一批次里候选词只解析一次（本地词表命中走缓存）', async () => {
    document.body.innerHTML = '<p>ubiquitous</p><p>ubiquitous</p><p>ubiquitous</p>';
    const resolveMany = vi.spyOn(DictionaryRegistry.prototype, 'resolveMany');
    const ctx = harness({ repeatMode: 'all' });
    await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
    // 三个文本节点在同一批里，只应触发一次批量解析
    expect(resolveMany).toHaveBeenCalledTimes(1);
    expect(ctx.renderer.count).toBe(3);
    resolveMany.mockRestore();
  });
});
