/**
 * 语境义挑选客户端：把「句子 + 生词」发给本机打分服务，拿回最合语境的义项。
 *
 * 服务端就是 `prototype/mt-align/xenc/serve.py`（0.5B 判别式打分器，留出集 71.8%）。
 * 义项表放在服务端，所以这里只发**句子 + 单词**，扩展不需要打包 229K 的义项数据。
 *
 * 三条硬性约定：
 * - **绝不抛错**。服务没起、超时、返回垃圾，都只是「这次没拿到」，页面继续用词典义。
 *   这是一个锦上添花的增强，任何情况下都不该影响正文渲染。
 * - **按 (单词, 句子) 缓存**，含「查无可用义项」这个否定结果，否则同一页会反复问同一个词。
 * - **默认关闭**：开启后会把整句发到 endpoint，属于隐私敏感行为，必须由用户显式打开。
 */

import { LruCache } from './lru.js';
import type { SenseSettings } from './settings.js';

/** 一个待决策点：某个句子里出现的某个生词。 */
export interface SenseCandidate {
  /** 调用方给的标识，用于把结果映射回 DOM。 */
  id: string;
  sentence: string;
  word: string;
}

/** 服务端给出的挑选结果。 */
export interface SensePick {
  /** 选中的义项文本。 */
  sense: string;
  /** 该词的候选义项总数。 */
  count: number;
  /** 各义项的分数，便于调试与「模型是否犹豫」的判断。 */
  scores: number[];
}

/**
 * 实际发出请求的那一层。
 *
 * 单独抽出来是因为**内容脚本不能直接 fetch**：它受页面 CSP / CORS 约束，
 * 而且会把本机服务地址暴露在页面上下文里。扩展里应当注入一个
 * 「转发给 service worker」的实现（与在线词典同一条路），单测里则注入假实现。
 * 返回解析后的 JSON；失败返回 null。
 */
export type SenseRequestFn = (
  endpoint: string,
  items: readonly SenseCandidate[],
  timeoutMs: number,
) => Promise<unknown | null>;

export interface SenseSelectorOptions {
  /** 惰性读取设置：设置可能随时被用户改。 */
  settings: () => SenseSettings;
  /** 覆盖请求层（扩展里走 service worker）。不传则直连 `fetch`。 */
  request?: SenseRequestFn;
  /** 直连模式下的 fetch 注入点，便于单测。 */
  fetchImpl?: typeof fetch;
  cacheSize?: number;
}

/**
 * 流水线只依赖这个最小接口，不依赖具体实现。
 *
 * 好处有两个：单测里可以塞一个几行的假实现；将来换成 ONNX / WebGPU 的
 * 页内推理时，也不必改动 `pipeline.ts`。
 */
export interface SensePicker {
  pick(items: readonly SenseCandidate[]): Promise<Map<string, SensePick>>;
}

/**
 * 语境义服务当下的状态。
 *
 * `unknown` 是**必须**存在的第四态：还没发过请求时不能对外宣称「不可达」——
 * 那是在替一个我们从没联系过的服务下结论。
 */
export type SenseReachability = 'unknown' | 'ok' | 'unreachable';

interface SelectResponseItem {
  id?: unknown;
  index?: unknown;
  selected?: unknown;
  senses?: unknown;
  scores?: unknown;
}

/** 服务端返回的 `index: -1` 表示「这个词没得选」，不值得再问，直接缓存成否定结果。 */
const NO_PICK = null;

/**
 * 一批发多少题。
 *
 * 服务端逐题前向、且有全局锁（约 61ms/题），把整页上限一次发出去必然超时；
 * 切片之后每批独立超时、独立落缓存，一批失败不牵连其他批。
 */
const CHUNK_SIZE = 32;

export class SenseSelector implements SensePicker {
  readonly #settings: () => SenseSettings;
  readonly #request: SenseRequestFn;
  readonly #cache: LruCache<SensePick | null>;
  /** 服务是否答过话；没试过就是没试过。 */
  #reachable: SenseReachability = 'unknown';

  constructor(options: SenseSelectorOptions) {
    this.#settings = options.settings;
    this.#request = options.request ?? directRequest(options.fetchImpl);
    this.#cache = new LruCache<SensePick | null>(options.cacheSize ?? 2000);
  }

  get cacheSize(): number {
    return this.#cache.size;
  }

  reachable(): SenseReachability {
    return this.#reachable;
  }

  /** 该词在该句下已缓存的结果；`undefined` 表示没查过，`null` 表示查过但没有可用义项。 */
  cached(word: string, sentence: string): SensePick | null | undefined {
    return this.#cache.get(cacheKey(word, sentence));
  }

  /**
   * 批量挑选。返回 `id → 结果`，只包含**真正拿到义项**的项；
   * 失败、超时、无候选的都不会出现在 Map 里，调用方据此跳过即可。
   */
  async pick(items: readonly SenseCandidate[]): Promise<Map<string, SensePick>> {
    const settings = this.#settings();
    const out = new Map<string, SensePick>();
    if (!settings.enabled || settings.endpoint === '' || items.length === 0) return out;

    // 先吃缓存，并记下还需要问服务端的词
    const pending: SenseCandidate[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = cacheKey(item.word, item.sentence);
      const hit = this.#cache.get(key);
      if (hit !== undefined) {
        if (hit !== NO_PICK) out.set(item.id, hit);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      pending.push(item);
    }
    if (pending.length === 0) return out;

    const limited = pending.slice(0, Math.max(0, settings.maxPerPage));
    if (limited.length === 0) return out;

    for (let start = 0; start < limited.length; start += CHUNK_SIZE) {
      const chunk = limited.slice(start, start + CHUNK_SIZE);
      const fetched = await this.#fetchPicks(settings, chunk);
      // 「可达」取**任一批成功**：长页面上本来就会分好几批（32 题一批），
      // 用最后一批的成败代表整个服务，会出现「有 40 处换成了语境义、却报服务不可达」这种自相矛盾。
      // 反过来，只有一次都没成功过才叫不可达——而且一旦不可达就先记下，之后成功会翻回 ok。
      if (fetched !== null) this.#reachable = 'ok';
      else if (this.#reachable === 'unknown') this.#reachable = 'unreachable';
      // 整批失败：**什么都不缓存**。把失败也记成「没得选」，会让一次超时永久禁掉这一批——
      // 滚动或重扫时也不再重试（这正是本轮修掉的缺陷）。
      if (fetched === null) continue;
      for (const item of chunk) {
        const entry = fetched.get(item.id);
        // 服务端没给这一项有效回执 → 同样不缓存，留待重试
        if (entry === undefined) continue;
        this.#cache.set(cacheKey(item.word, item.sentence), entry);
        if (entry !== NO_PICK) out.set(item.id, entry);
      }
    }
    return out;
  }

  /**
   * 发一批，并区分三种回执：
   * - 返回 `null`：整批失败（超时 / 连不上 / 非 2xx / 响应形状不对）→ 调用方什么都不缓存；
   * - 映射里没有某个 id：这一项服务端没给有效回执（缺 id / 缺字段）→ 也不缓存；
   * - 映射里该 id 的值是 `NO_PICK`：服务端**明确**说了这个词没得选（`index: -1`）→ 缓存成否定结果。
   */
  async #fetchPicks(
    settings: SenseSettings,
    items: readonly SenseCandidate[],
  ): Promise<Map<string, SensePick | null> | null> {
    const payload = await this.#request(settings.endpoint, items, settings.timeoutMs);
    if (payload === null) return null;
    const results = (payload as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) return null;

    const out = new Map<string, SensePick | null>();
    for (const raw of results as SelectResponseItem[]) {
      const id = typeof raw?.id === 'string' ? raw.id : null;
      if (id === null) continue;
      const index = raw.index;
      if (typeof index !== 'number') continue;
      if (index < 0) {
        out.set(id, NO_PICK); // 服务端明确说「这个词没得选」
        continue;
      }
      const parsed = parsePick(raw);
      if (parsed === null) continue;
      out.set(id, parsed);
    }
    return out;
  }
}

/** 直连实现（原型 / 非扩展环境用）。 */
function directRequest(fetchImpl?: typeof fetch): SenseRequestFn {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return async (endpoint, items, timeoutMs) => {
    try {
      const response = await doFetch(`${endpoint}/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: items.map((item) => ({ id: item.id, sentence: item.sentence, word: item.word })),
        }),
        signal: timeoutSignal(timeoutMs),
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      // 服务没起 / 网络失败 / 超时：静默放弃，页面保持词典义
      return null;
    }
  };
}

function cacheKey(word: string, sentence: string): string {
  return `${word.toLowerCase()}\u0000${sentence}`;
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const factory = (
    globalThis as { AbortSignal?: { timeout?: (value: number) => AbortSignal } }
  ).AbortSignal?.timeout;
  return typeof factory === 'function' ? factory(ms) : undefined;
}

/**
 * 校验一条服务端结果。
 *
 * 只负责「服务端给了一个有效下标」这一种情形：`index < 0`（没得选）由 `#fetchPicks`
 * 单独识别并落否定缓存，形状不对则整条丢弃、不缓存——两者在缓存语义上已经分开，
 * 这里保留 `< 0` 的判断是为了防止漏网的负下标被当成一次「选中」。
 */
function parsePick(raw: SelectResponseItem | undefined): SensePick | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const index = raw.index;
  const selected = raw.selected;
  if (typeof index !== 'number' || index < 0) return null;
  if (typeof selected !== 'string' || selected === '') return null;
  const senses = Array.isArray(raw.senses) ? raw.senses : [];
  const scores = Array.isArray(raw.scores) ? raw.scores.filter((v): v is number => typeof v === 'number') : [];
  return { sense: selected, count: senses.length || scores.length, scores };
}
