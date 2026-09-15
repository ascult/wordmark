import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepeatTracker } from '../src/core/annotator.js';
import type { SenseCandidate, SensePick, SensePicker } from '../src/core/sense-selector.js';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/settings.js';
import type { DictEntry } from '../src/core/types.js';
import { DomWalker } from '../src/content/dom-walker.js';
import { GlossRenderer } from '../src/content/gloss-renderer.js';
import { AnnotationPipeline } from '../src/content/pipeline.js';
import { OfflineDictionary } from '../src/dict/offline.js';
import { DictionaryRegistry } from '../src/dict/registry.js';

const ENTRIES: DictEntry[] = [
  { word: 'engine', pos: 'n.', gloss: '发动机', level: 'cet4' },
  { word: 'rudder', pos: 'n.', gloss: '舵', level: 'gre' },
  { word: 'ubiquitous', pos: 'adj.', gloss: '无处不在的', level: 'gre' },
];

function senseSettings(patch: Partial<Settings['sense']> = {}): Settings['sense'] {
  return { ...DEFAULT_SETTINGS.sense, enabled: true, ...patch };
}

interface HarnessOptions {
  sense?: SensePicker;
  sensePatch?: Partial<Settings['sense']>;
  /** 其余设置项（例如把 repeatMode 改成 all，让同一个词能被标多次）。 */
  overrides?: Partial<Settings>;
}

function harness(options: HarnessOptions = {}) {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    ...options.overrides,
    sense: senseSettings(options.sensePatch),
  };
  const registry = new DictionaryRegistry().addLocal(new OfflineDictionary({ entries: ENTRIES }));
  const renderer = new GlossRenderer();
  const walker = new DomWalker(document.body);
  const repeat = new RepeatTracker(settings.repeatMode);

  const pipeline = new AnnotationPipeline({
    registry,
    renderer,
    walker: () => walker,
    settings: () => settings,
    knownWords: () => new Set<string>(),
    repeat: () => repeat,
    sense: options.sense,
    yieldControl: async () => {},
  });

  return { settings, renderer, pipeline, walker };
}

/** 记录每次收到的候选，并按给定的义项表作答。 */
function recordingPicker(picks: Record<string, string>): {
  picker: SensePicker;
  calls: SenseCandidate[][];
} {
  const calls: SenseCandidate[][] = [];
  const picker: SensePicker = {
    async pick(items) {
      calls.push([...items]);
      const out = new Map<string, SensePick>();
      for (const item of items) {
        const sense = picks[item.word];
        if (sense === undefined) continue;
        out.set(item.id, { sense, count: 2, scores: [1, 2] });
      }
      return out;
    },
  };
  return { picker, calls };
}

async function run(html: string, options: HarnessOptions = {}) {
  document.body.innerHTML = html;
  const ctx = harness(options);
  await ctx.pipeline.processNodes(ctx.walker.collect(document.body));
  return ctx;
}

/** 等待微任务队列清空：语境义回填是 promise 里做的。 */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('流水线的语境义回填', () => {
  it('先渲染词典义，再就地替换成语境义', async () => {
    const { picker, calls } = recordingPicker({ engine: '驱动力/推动力' });
    const ctx = await run('<p>The engine drives great work forward.</p>', { sense: picker });

    expect(calls).toHaveLength(1);
    await settle();
    expect(document.body.textContent).toBe('The engine（驱动力/推动力） drives great work forward.');
    expect(ctx.renderer.count).toBe(1);
  });

  it('发给模型的上下文是整句，且不含已插入的中文释义', async () => {
    const { picker, calls } = recordingPicker({ engine: '驱动力', ubiquitous: '无处不在的' });
    await run('<p>The engine is ubiquitous in modern teams everywhere.</p>', { sense: picker });
    await settle();

    const sentences = calls.flat().map((item) => item.sentence);
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences) {
      expect(sentence).not.toContain('（');
      expect(sentence).toContain('The engine is ubiquitous');
    }
  });

  it('模型没给出结果时保持词典义，页面不受影响', async () => {
    const { picker } = recordingPicker({}); // 什么都不选
    await run('<p>The engine drives great work forward.</p>', { sense: picker });
    await settle();
    expect(document.body.textContent).toBe('The engine（发动机） drives great work forward.');
  });

  it('设置关闭时完全不调用挑选器', async () => {
    const pick = vi.fn(async () => new Map<string, SensePick>());
    await run('<p>The engine drives great work forward.</p>', {
      sense: { pick },
      sensePatch: { enabled: false },
    });
    await settle();
    expect(pick).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('（发动机）');
  });

  it('没注入挑选器时行为与以前完全一致', async () => {
    await run('<p>The engine drives great work forward.</p>');
    expect(document.body.textContent).toBe('The engine（发动机） drives great work forward.');
  });

  it('挑选器抛错时被吞掉，不会冒泡到整页标注', async () => {
    const picker: SensePicker = {
      pick: async () => {
        throw new Error('boom');
      },
    };
    await expect(run('<p>The engine drives great work forward.</p>', { sense: picker })).resolves.toBeTruthy();
    await settle();
    expect(document.body.textContent).toContain('（发动机）');
  });

  it('processNodes 不等待模型：慢挑选器不阻塞渲染', async () => {
    // 用对象持有 resolve，避免 TS 把闭包外的赋值收窄成 never
    const gate: { release?: () => void } = {};
    const picker: SensePicker = {
      pick: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return new Map<string, SensePick>();
      },
    };
    const ctx = await run('<p>The engine drives great work forward.</p>', { sense: picker });
    // 挑选还挂着，但渲染已经完成、processNodes 已经返回
    expect(document.body.textContent).toContain('（发动机）');
    expect(ctx.pipeline.busy).toBe(false);
    gate.release?.();
    await settle();
  });

  it('maxPerPage 限制本页送去挑选的处数', async () => {
    const { picker, calls } = recordingPicker({});
    await run(
      '<p>The engine runs. The rudder turns. The place is ubiquitous.</p>',
      { sense: picker, sensePatch: { maxPerPage: 2 } },
    );
    await settle();
    expect(calls.flat()).toHaveLength(2);
  });

  it('resetSenseBudget 之后配额重新可用', async () => {
    const { picker, calls } = recordingPicker({});
    const first = await run('<p>The engine runs on and on here.</p>', {
      sense: picker,
      sensePatch: { maxPerPage: 1 },
    });
    await settle();
    expect(calls.flat()).toHaveLength(1);

    // 重扫：换一个干净的 walker（旧 walker 缓存的是旧 DOM）
    first.pipeline.resetSenseBudget();
    document.body.innerHTML = '<p>The rudder turns here again today.</p>';
    const second = harness({ sense: picker, sensePatch: { maxPerPage: 1 } });
    await second.pipeline.processNodes(second.walker.collect(document.body));
    await settle();
    expect(calls.flat()).toHaveLength(2);
  });

  it('同一个词在两处可以拿到不同义项（逐处更新，而非按词元）', async () => {
    const custom: SensePicker = {
      async pick(items) {
        const out = new Map<string, SensePick>();
        items.forEach((item, index) => {
          out.set(item.id, {
            sense: index === 0 ? '发动机/引擎' : '驱动力/推动力',
            count: 2,
            scores: [],
          });
        });
        return out;
      },
    };
    await run('<p>The engine is here. Another engine is there.</p>', {
      sense: custom,
      // 默认 repeatMode=first 只会标第一次出现，这里要测「逐处」就必须两处都标
      overrides: { repeatMode: 'all' },
    });
    await settle();
    expect(document.body.textContent).toBe(
      'The engine（发动机/引擎） is here. Another engine（驱动力/推动力） is there.',
    );
  });

  it('默认只在第一次出现处标注（repeatMode=first），第二处保持无标注', async () => {
    const { picker, calls } = recordingPicker({ engine: '驱动力' });
    await run('<p>The engine is here. Another engine is there.</p>', { sense: picker });
    await settle();
    expect(calls.flat()).toHaveLength(1);
    expect(document.body.textContent).toBe('The engine（驱动力） is here. Another engine is there.');
  });
});
