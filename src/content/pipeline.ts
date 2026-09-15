/**
 * 标注流水线：文本节点 → 候选词 → 查词 → 渲染 → （可选）语境义回填。
 *
 * 从 content script 入口里拆出来，是为了让「页面标注」这条主路径
 * 能在 jsdom 下直接单测——入口文件只负责接线和事件绑定。
 *
 * 三个性能/正确性决定：
 * - 先把整批节点的候选词收集起来一次解析，本地词表在大批量下
 *   命中率高，能显著减少 message 往返；
 * - 每批结束让出主线程，避免长文页面卡顿；
 * - **渲染与语境义分两段**：词典义先立刻上屏，模型结果回来了再就地替换。
 *   本机打分器对一篇文章要几十秒，任何情况下都不能阻塞正文渲染。
 */

import { RepeatTracker, shouldAnnotate } from '../core/annotator.js';
import type { SenseCandidate, SensePicker } from '../core/sense-selector.js';
import type { Settings } from '../core/settings.js';
import { isCandidateToken, normalizeToken, tokenize, type Token } from '../core/tokenizer.js';
import type { DictionaryRegistry } from '../dict/registry.js';
import type { DomWalker } from './dom-walker.js';
import type { GlossMatch, GlossRenderer } from './gloss-renderer.js';
import { BlockIndex } from './sentence-context.js';

/** 每批处理的文本节点数：太大掉帧，太小往返变多。 */
export const BATCH_SIZE = 120;

export interface PipelineDeps {
  registry: DictionaryRegistry;
  renderer: GlossRenderer;
  /** 用 getter 而不是实例：全量重扫时会换一个新的 walker（缓存失效）。 */
  walker: () => DomWalker;
  settings: () => Settings;
  knownWords: () => ReadonlySet<string>;
  repeat: () => RepeatTracker;
  /** 记录「词典未收录」的词，供弹窗统计。 */
  unresolved?: Set<string>;
  /** 语境义挑选；不注入或设置关闭时完全不介入。 */
  sense?: SensePicker;
  /** 让出主线程的钩子；单测里注入同步实现。 */
  yieldControl?: () => Promise<void>;
}

export class AnnotationPipeline {
  #processing = false;
  #pending = false;
  /** 本页已经送去挑选语境义的处数，用于 `sense.maxPerPage` 限流。 */
  #senseUsed = 0;
  /** 本页实际换成语境义的处数，供弹窗回答「有没有生效」。 */
  #contextual = 0;
  readonly #deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#processing;
  }

  /**
   * 本页用上语境义的处数。
   *
   * **已知近似**：数的是「成功回填的次数」。回填后文本与词典义恰好相同的那一次也会计入，
   * 而点了「已认识」把该词释义移除之后也不会回退——所以它只会偏大，不会偏小。
   * 要精确得让渲染器按「仍在页面上、且被标记为语境义的记录」来数（下一步）。
   */
  get contextualCount(): number {
    return this.#contextual;
  }

  /** 全量重扫时清零语境义的配额与计数。 */
  resetSenseBudget(): void {
    this.#senseUsed = 0;
    this.#contextual = 0;
  }

  /**
   * 顺序处理一批文本节点。重入时记录一次「待重扫」，由外层决定何时再跑。
   */
  async processNodes(nodes: readonly Text[]): Promise<void> {
    if (this.#processing) {
      this.#pending = true;
      return;
    }
    this.#processing = true;
    const yieldControl = this.#deps.yieldControl ?? defaultYield;
    try {
      for (let index = 0; index < nodes.length; index += BATCH_SIZE) {
        await this.processBatch(nodes.slice(index, index + BATCH_SIZE));
        await yieldControl();
      }
    } finally {
      this.#processing = false;
    }
  }

  /** 供入口层判断是否需要补一次全量扫描。 */
  consumePending(): boolean {
    const pending = this.#pending;
    this.#pending = false;
    return pending;
  }

  async processBatch(batch: readonly Text[]): Promise<void> {
    const settings = this.#deps.settings();
    const walker = this.#deps.walker();
    const prepared: Array<{ node: Text; tokens: Token[] }> = [];
    const surfaces = new Set<string>();

    for (const node of batch) {
      if (!node.isConnected) continue;
      // 不要在这里按「是否渲染器创建的节点」过滤！
      // 第一次渲染后，正文的大部分文本已经存在于渲染器插入的间隙文本节点里；
      // 重扫时把它们当成「自己的产物」跳过，会让标注逐次衰减
      // （真浏览器实测：410 → 9 → 3 处）。
      // 幂等性由 walker.isTextCandidate 保证：标注外壳带 data-wordmark，
      // 其后代永远不会被再次收集。isOwn 只用于 MutationObserver 过滤自身变更。
      if (!walker.isTextCandidate(node)) continue;
      const tokens: Token[] = [];
      for (const token of tokenize(node.data)) {
        if (!isCandidateToken(token.text, { minWordLength: settings.minWordLength })) continue;
        tokens.push(token);
        surfaces.add(normalizeToken(token.text));
      }
      if (tokens.length > 0) prepared.push({ node, tokens });
    }
    if (prepared.length === 0) return;

    const resolved = await this.#deps.registry.resolveMany(surfaces);
    const unresolved = this.#deps.unresolved;
    if (unresolved) {
      for (const surface of surfaces) {
        if (resolved.has(surface)) unresolved.delete(surface);
        else unresolved.add(surface);
      }
    }

    const policy = {
      annotateFrom: settings.annotateFrom,
      knownWords: this.#deps.knownWords(),
    };
    const repeat = this.#deps.repeat();
    let budget = settings.maxGlossesPerPage - this.#deps.renderer.count;

    // 阶段一：决定标什么，并把每处标注的「句子上下文」算出来。
    // 必须在**任何渲染之前**算完：渲染会往段落里插入中文释义，
    // 之后再算就会得到 `ubiquitous（无处不在的）` 这种混了中文的上下文。
    const blockIndex = new BlockIndex();
    const planned: Array<{
      node: Text;
      matches: GlossMatch[];
      /** 与 `matches` 一一对应；null 表示取不到可用句子。 */
      sentences: Array<string | null>;
    }> = [];

    for (const item of prepared) {
      if (budget <= 0) break;
      const matches: GlossMatch[] = [];
      const sentences: Array<string | null> = [];
      for (const token of item.tokens) {
        if (budget <= 0) break;
        const result = resolved.get(normalizeToken(token.text));
        if (!result) continue;
        if (!shouldAnnotate(result.lemma, result.level, policy)) continue;
        if (!repeat.allows(result.lemma)) continue;
        repeat.note(result.lemma);
        matches.push({ token, result });
        sentences.push(blockIndex.sentenceFor(item.node, token.start));
        budget -= 1;
      }
      if (matches.length > 0) planned.push({ node: item.node, matches, sentences });
    }

    // 阶段二：渲染。词典义立刻上屏，不等模型。
    const candidates: SenseCandidate[] = [];
    for (const item of planned) {
      this.#deps.renderer.renderNode(item.node, item.matches, {
        showPos: settings.showPos,
        style: settings.glossStyle,
        onGloss: (gloss) => {
          const sentence = item.sentences[gloss.matchIndex];
          if (typeof sentence !== 'string' || sentence === '') return;
          candidates.push({ id: String(gloss.id), sentence, word: gloss.lemma });
        },
      });
    }

    // 阶段三：语境义。异步、不 await——否则每批都要等模型，整页标注会被拖死。
    this.#requestSenses(candidates);
  }

  /**
   * 把候选发给打分服务，回来后**就地**替换那几处的释义。
   *
   * 失败、超时、服务没起都只是「这次没换成」，页面保持词典义——
   * 这是增强功能，不该有任何可见的错误路径。
   */
  #requestSenses(candidates: readonly SenseCandidate[]): void {
    const selector = this.#deps.sense;
    if (!selector || candidates.length === 0) return;
    const settings = this.#deps.settings();
    if (!settings.sense.enabled) return;

    const room = settings.sense.maxPerPage - this.#senseUsed;
    if (room <= 0) return;
    const slice = candidates.slice(0, room);
    if (slice.length === 0) return;
    this.#senseUsed += slice.length;

    void selector
      .pick(slice)
      .then((picks) => {
        for (const [id, pick] of picks) {
          const numeric = Number(id);
          if (!Number.isInteger(numeric)) continue;
          if (this.#deps.renderer.updateGlossText(numeric, pick.sense)) this.#contextual += 1;
        }
      })
      .catch(() => {
        // 已经有兜底：pick() 自己绝不抛错；这里只是防止将来改动引入意外
      });
  }
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (
      globalThis as {
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      }
    ).requestIdleCallback;
    if (typeof idle === 'function') {
      idle(() => resolve(), { timeout: 200 });
      return;
    }
    setTimeout(resolve, 0);
  });
}
