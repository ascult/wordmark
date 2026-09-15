/**
 * content script 入口：接线 + 生命周期 + 事件绑定。
 *
 * 真正的标注逻辑在 `pipeline.ts`（可在 jsdom 下单测），
 * 这里只做「读设置 → 起流水线 → 监听动态内容与用户操作」。
 */

import { RepeatTracker } from '../core/annotator.js';
import { isWordmarkRequest, sendRequest, type PageStats, type WordmarkResponse } from '../core/messages.js';
import { SenseSelector } from '../core/sense-selector.js';
import {
  DEFAULT_SETTINGS,
  isHostBlocked,
  loadKnownWords,
  loadSettings,
  onStorageChanged,
  type Settings,
} from '../core/settings.js';
import type { DictionaryProvider, LookupResult, ProviderId } from '../core/types.js';
import { OfflineDictionary } from '../dict/offline.js';
import { DictionaryRegistry } from '../dict/registry.js';
import {
  DEF_CLASS,
  LEMMA_ATTR,
  MARK_CLASS,
  ROOT_CLASS,
  ROOT_STYLE_PREFIX,
  TOAST_CLASS,
} from './constants.js';
import { DomWalker } from './dom-walker.js';
import { GlossRenderer } from './gloss-renderer.js';
import { DomWatcher } from './observer.js';
import { AnnotationPipeline } from './pipeline.js';

/**
 * 在线词典的「页内代理」：把查询转发给 service worker。
 *
 * 不在页面里直接 fetch 的好处：不受站点 CORS / CSP 影响，
 * 且速率限制与缓存只在一个地方实现，多标签页共享。
 */
class BackgroundDictionary implements DictionaryProvider {
  readonly kind = 'remote' as const;
  #provider: ProviderId = 'mymemory';

  constructor(private readonly isEnabled: () => boolean) {}

  get id(): ProviderId {
    return this.#provider;
  }

  setId(id: ProviderId): void {
    this.#provider = id;
  }

  available(): boolean {
    return this.isEnabled();
  }

  async lookup(query: string): Promise<LookupResult | null> {
    const data = await sendRequest<{ result: LookupResult | null }>({
      type: 'wordmark:lookup',
      word: query,
    });
    const result = data.ok ? data.data.result : null;
    if (result) this.#provider = result.source;
    return result;
  }
}

const offline = new OfflineDictionary();
const background = new BackgroundDictionary(() => state.settings.online.enabled);
const registry = new DictionaryRegistry().addLocal(offline).addRemote(background);

const renderer = new GlossRenderer();

/**
 * 语境义挑选器。
 *
 * 请求走 service worker（`SenseProxy`）而不是页内直连：内容脚本的 fetch 算页面发起的，
 * 会受站点 CSP / CORS 约束，也会把本机服务地址暴露在页面上下文里。
 * 设置是惰性读取的（用户可以随时开关）。
 */
const senseSelector = new SenseSelector({
  settings: () => state.settings.sense,
  request: async (endpoint, items, timeoutMs) => {
    void endpoint;
    void timeoutMs;
    const response = await sendRequest<unknown>({
      type: 'wordmark:sense',
      items: items.map((item) => ({ id: item.id, sentence: item.sentence, word: item.word })),
    });
    return response.ok ? response.data : null;
  },
});

const state = {
  settings: DEFAULT_SETTINGS as Settings,
  knownWords: new Set<string>(),
  walker: new DomWalker(document.body ?? document.documentElement),
  renderer,
  repeat: new RepeatTracker(DEFAULT_SETTINGS.repeatMode),
  watcher: null as DomWatcher | null,
  unresolved: new Set<string>(),
  active: false,
  host: location.hostname,
};

const pipeline = new AnnotationPipeline({
  registry,
  renderer,
  walker: () => state.walker,
  settings: () => state.settings,
  knownWords: () => state.knownWords,
  repeat: () => state.repeat,
  unresolved: state.unresolved,
  sense: senseSelector,
});

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

function shouldRun(settings: Settings, host: string): boolean {
  if (!settings.enabled) return false;
  return !isHostBlocked(host, settings.blockedHosts);
}

function applyRootState(): void {
  const root = document.documentElement;
  root.classList.toggle(ROOT_CLASS, state.active);
  for (const name of [...root.classList]) {
    if (name.startsWith(ROOT_STYLE_PREFIX)) root.classList.remove(name);
  }
  if (state.active) root.classList.add(`${ROOT_STYLE_PREFIX}${state.settings.glossStyle}`);
}

function syncDerivedState(): void {
  state.repeat = new RepeatTracker(state.settings.repeatMode);
  background.setId(state.settings.online.provider);
}

async function start(): Promise<void> {
  const [settings, knownWords] = await Promise.all([loadSettings(), loadKnownWords()]);
  state.settings = settings;
  state.knownWords = new Set(knownWords);
  syncDerivedState();

  state.active = shouldRun(settings, state.host);
  applyRootState();
  // 监听始终注册：即使当前站点被关闭，用户从弹窗里打开开关也能立刻生效。
  registerListeners();
  if (!state.active) return;

  // 先挂监听再扫描：否则「扫描开始」到「监听建立」之间新增的节点会漏掉。
  // 扫描期间的变更由 DomWatcher 排队去抖，扫描结束后自然被处理。
  startWatcher();
  await scan();
}

function startWatcher(): void {
  state.watcher?.stop();
  if (!state.settings.dynamicContent || !document.body || !state.active) return;
  state.watcher = new DomWatcher(state.walker, (nodes) => void processNodes(nodes), {
    isOwnNode: (node) => renderer.isOwn(node),
  });
  state.watcher.start(document.body);
}

/** 全量重扫：设置变更后的重建，保证页面状态与设置一致。 */
async function rescan(): Promise<void> {
  if (!state.active) return;
  state.watcher?.stop();
  renderer.unmarkAll(document);
  state.unresolved.clear();
  state.repeat = new RepeatTracker(state.settings.repeatMode);
  pipeline.resetSenseBudget();
  state.walker = new DomWalker(document.body ?? document.documentElement);
  startWatcher();
  await scan();
}

async function scan(): Promise<void> {
  if (!state.active || !document.body) return;
  await processNodes(state.walker.collect(document.body));
}

async function processNodes(nodes: readonly Text[]): Promise<void> {
  if (!state.active) return;
  await pipeline.processNodes(nodes);
  if (pipeline.consumePending()) await scan();
}

/* ------------------------------------------------------------------ */
/* 交互与事件                                                          */
/* ------------------------------------------------------------------ */

let toast: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(message: string): void {
  if (!toast) {
    toast = document.createElement('div');
    toast.className = TOAST_CLASS;
    document.documentElement.appendChild(toast);
  }
  toast.textContent = message;
  toast.setAttribute('data-visible', '1');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast?.setAttribute('data-visible', '0'), 2600);
}

/**
 * 点击「中文释义」= 我认识这个词：本页立即撤掉它的释义，并写入已知词表。
 *
 * 只有点中文部分才算标记，点英文原词仍然照常跳转链接——否则会
 * 悄悄吃掉正常的点击。
 */
function handleClick(event: MouseEvent): void {
  if (!state.active) return;
  const target = event.target as Element | null;
  const definition = target?.closest?.(`.${DEF_CLASS}`);
  if (!definition) return;
  const wrapper = definition.closest(`.${MARK_CLASS}`);
  const lemma = wrapper?.getAttribute(LEMMA_ATTR);
  if (!lemma) return;
  event.preventDefault();
  event.stopPropagation();
  state.knownWords.add(lemma);
  const removed = renderer.removeLemma(lemma);
  showToast(`已标记「${lemma}」为已知词，本页移除 ${removed} 处释义`);
  void sendRequest({ type: 'wordmark:mark-known', word: lemma, known: true });
}

function statsSnapshot(): PageStats {
  return {
    host: state.host,
    glossed: renderer.count,
    unique: renderer.uniqueCount,
    unresolved: state.unresolved.size,
    contextual: pipeline.contextualCount,
    sense: senseSelector.reachable(),
    active: state.active,
  };
}

function registerListeners(): void {
  document.addEventListener('click', handleClick, true);

  const runtime = typeof chrome === 'undefined' ? undefined : chrome.runtime;
  runtime?.onMessage?.addListener((message: unknown, _sender, sendResponse) => {
    if (!isWordmarkRequest(message)) return undefined;
    if (message.type === 'wordmark:page-stats') {
      sendResponse({ ok: true, data: statsSnapshot() } satisfies WordmarkResponse<PageStats>);
      return undefined;
    }
    if (message.type === 'wordmark:apply-settings') {
      void rescan();
      sendResponse({ ok: true, data: null } satisfies WordmarkResponse<null>);
      return undefined;
    }
    return undefined;
  });

  onStorageChanged((change) => {
    if (change.settings) {
      applySettingsChange(change.settings);
      return;
    }
    if (change.knownWords) {
      state.knownWords = new Set(change.knownWords);
      // 新增的已知词就地撤销；被移除的等下一次扫描自然恢复。
      for (const lemma of state.knownWords) renderer.removeLemma(lemma);
    }
  });
}

function applySettingsChange(next: Settings): void {
  const previous = state.settings;
  const structural =
    next.enabled !== previous.enabled ||
    next.annotateFrom !== previous.annotateFrom ||
    next.minWordLength !== previous.minWordLength ||
    next.repeatMode !== previous.repeatMode ||
    next.showPos !== previous.showPos ||
    next.glossStyle !== previous.glossStyle ||
    next.maxGlossesPerPage !== previous.maxGlossesPerPage ||
    next.dynamicContent !== previous.dynamicContent ||
    next.online.enabled !== previous.online.enabled ||
    next.online.provider !== previous.online.provider ||
    next.online.customUrl !== previous.online.customUrl ||
    next.online.customPath !== previous.online.customPath ||
    // 语境义开关/地址变了要重扫：已上屏的是词典义，需要重新挑一遍
    next.sense.enabled !== previous.sense.enabled ||
    next.sense.endpoint !== previous.sense.endpoint ||
    next.blockedHosts.join(',') !== previous.blockedHosts.join(',');

  state.settings = next;
  syncDerivedState();
  state.active = shouldRun(next, state.host);
  applyRootState();
  if (!structural) return;

  if (!state.active) {
    state.watcher?.stop();
    renderer.unmarkAll(document);
    return;
  }
  void rescan();
}

void start();
