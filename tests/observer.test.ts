import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DomWalker } from '../src/content/dom-walker.js';
import { DomWatcher } from '../src/content/observer.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * jsdom 把 MutationObserver 的记录放在宏任务里投递，时间点不确定，
 * 所以断言一律用 vi.waitFor 轮询，而不是假设某个固定延迟已经过去。
 */
function queued(watcher: DomWatcher): Promise<void> {
  return vi.waitFor(() => {
    expect(watcher.pending).toBeGreaterThan(0);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('DomWatcher', () => {
  it('捕获新增节点里的文本，并合并为一批回调', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    const watcher = new DomWatcher(walker, onText, { debounceMs: 5 });
    watcher.start(document.body);

    document.body.innerHTML = '<p>first batch</p>';
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

    const nodes = onText.mock.calls[0]?.[0] as Text[];
    expect(nodes.map((node) => node.data)).toEqual(['first batch']);
    watcher.stop();
  });

  it('同一批变更只回调一次（去抖合并）', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    const watcher = new DomWatcher(walker, onText, { debounceMs: 20 });
    watcher.start(document.body);

    // 一次性改 body 的子树 = 一条 childList 记录，避免依赖 jsdom
    // 「多次 DOM 操作是否被合并投递」这种不确定的时间行为
    document.body.innerHTML = '<p>one</p><p>two</p><p>three</p>';
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

    const texts = (onText.mock.calls[0]?.[0] as Text[]).map((node) => node.data);
    expect(texts).toEqual(['one', 'two', 'three']);
    watcher.stop();
  });

  it('忽略自己注入的节点，避免自激循环', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    // 把 <span class="own"> 视为本扩展创建的节点
    const watcher = new DomWatcher(walker, onText, {
      debounceMs: 5,
      isOwnNode: (node) => node.nodeType === 1 && (node as Element).classList.contains('own'),
    });
    watcher.start(document.body);

    const own = document.createElement('span');
    own.className = 'own';
    own.textContent = 'injected gloss';
    document.body.appendChild(own);

    // 同一个批次里再放一个正常节点：只要它到了，就说明 own 节点被过滤掉了
    const visible = document.createElement('p');
    visible.textContent = 'visible words';
    document.body.appendChild(visible);

    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));
    const texts = (onText.mock.calls[0]?.[0] as Text[]).map((node) => node.data);
    expect(texts).toEqual(['visible words']);
    watcher.stop();
  });

  it('跳过不可见与代码区域的新增内容', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    const watcher = new DomWatcher(walker, onText, { debounceMs: 5 });
    watcher.start(document.body);

    const hidden = document.createElement('p');
    hidden.setAttribute('hidden', '');
    hidden.textContent = 'hidden words';
    const code = document.createElement('code');
    code.textContent = 'code words';
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editable.textContent = 'editable words';
    const normal = document.createElement('p');
    normal.textContent = 'visible words';

    document.body.append(hidden, code, editable, normal);
    await vi.waitFor(() => expect(onText).toHaveBeenCalledTimes(1));

    const texts = (onText.mock.calls[0]?.[0] as Text[]).map((node) => node.data);
    expect(texts).toEqual(['visible words']);
    watcher.stop();
  });

  it('stop 之后不再回调，并清空队列', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    // 去抖设得很长，保证队列不会在断言之前被自动消费
    const watcher = new DomWatcher(walker, onText, { debounceMs: 10_000 });
    watcher.start(document.body);

    const first = document.createElement('p');
    first.textContent = 'before stop';
    document.body.appendChild(first);
    await queued(watcher);

    watcher.stop();
    expect(watcher.running).toBe(false);
    expect(watcher.pending).toBe(0);

    const second = document.createElement('p');
    second.textContent = 'after stop';
    document.body.appendChild(second);
    await wait(150);
    expect(onText).not.toHaveBeenCalled();
  });

  it('flush 立即处理排队内容，不等去抖', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    const watcher = new DomWatcher(walker, onText, { debounceMs: 10_000 });
    watcher.start(document.body);

    const paragraph = document.createElement('p');
    paragraph.textContent = 'queued text';
    document.body.appendChild(paragraph);

    await queued(watcher);
    watcher.flush();
    expect(onText).toHaveBeenCalledTimes(1);
    expect((onText.mock.calls[0]?.[0] as Text[]).map((node) => node.data)).toEqual(['queued text']);
    watcher.stop();
  });

  it('队列超限时丢弃而不是无限增长', async () => {
    const walker = new DomWalker(document.body);
    const onText = vi.fn();
    const watcher = new DomWatcher(walker, onText, { debounceMs: 10_000, maxQueue: 2 });
    watcher.start(document.body);

    const container = document.createElement('div');
    container.innerHTML = '<span>one</span><span>two</span><span>three</span><span>four</span>';
    document.body.appendChild(container);

    await vi.waitFor(() => expect(watcher.dropped).toBeGreaterThan(0));
    expect(watcher.pending).toBeLessThanOrEqual(2);
    watcher.stop();
  });

  it('重复 start 不会挂上两个 observer', () => {
    const walker = new DomWalker(document.body);
    const watcher = new DomWatcher(walker, () => {}, { debounceMs: 5 });
    watcher.start(document.body);
    watcher.start(document.body);
    expect(watcher.running).toBe(true);
    watcher.stop();
    expect(watcher.running).toBe(false);
  });

  it('start 之前 stop 是安全操作', () => {
    const walker = new DomWalker(document.body);
    const watcher = new DomWatcher(walker, () => {}, { debounceMs: 5 });
    expect(() => watcher.stop()).not.toThrow();
    expect(watcher.running).toBe(false);
  });
});
