/**
 * MV3 service worker:消息分发 + 首次安装写默认设置。
 *
 * 它只做「页面里做不了或做不好」的事的接线:在线查询、跨标签页
 * 缓存与限流在 `lookup.ts`,持久化写操作在 `core/settings.ts`。
 * 本文件里没有值得单测的逻辑——行为都在被调用的模块里。
 */

import {
  isWordmarkRequest,
  type StateSnapshot,
  type WordmarkRequest,
  type WordmarkResponse,
} from '../core/messages.js';
import {
  addKnownWord,
  DEFAULT_SETTINGS,
  isHostBlocked,
  loadKnownWords,
  loadSettings,
  removeKnownWord,
  saveKnownWords,
  saveSettings,
  storageArea,
  updateSettings,
} from '../core/settings.js';
import { OnlineLookup } from './lookup.js';
import { SenseProxy } from './sense.js';

const onlineLookup = new OnlineLookup({ storage: storageArea('local') });
const senseProxy = new SenseProxy();

async function handleMessage(message: BackgroundRequest): Promise<WordmarkResponse<unknown>> {
  switch (message.type) {
    case 'wordmark:lookup': {
      const settings = await loadSettings();
      const result = await onlineLookup.lookup(message.word, settings.online);
      return { ok: true, data: { result } };
    }
    case 'wordmark:sense': {
      const settings = await loadSettings();
      // 关闭时直接返回空结果：页面不会因为这条消息产生任何网络行为
      const payload = await senseProxy.select(settings.sense, message.items);
      return { ok: true, data: payload ?? { results: [] } };
    }
    case 'wordmark:mark-known': {
      const knownWords = message.known
        ? await addKnownWord(message.word)
        : await removeKnownWord(message.word);
      return { ok: true, data: { knownWords } };
    }
    case 'wordmark:get-state': {
      const [settings, knownWords] = await Promise.all([loadSettings(), loadKnownWords()]);
      const snapshot: StateSnapshot = {
        settings,
        knownWords,
        hostBlocked: isHostBlocked(message.host, settings.blockedHosts),
      };
      return { ok: true, data: snapshot };
    }
    case 'wordmark:set-site-enabled': {
      const settings = await loadSettings();
      const host = message.host.toLowerCase().replace(/^www\./, '');
      const blocked = new Set(settings.blockedHosts);
      if (message.enabled) blocked.delete(host);
      else blocked.add(host);
      const next = { ...settings, blockedHosts: [...blocked] };
      await saveSettings(next);
      return { ok: true, data: { settings: next } };
    }
    case 'wordmark:set-settings': {
      const settings = await updateSettings(message.patch);
      return { ok: true, data: { settings } };
    }
    case 'wordmark:set-known-words': {
      const knownWords = await saveKnownWords(message.words);
      return { ok: true, data: { knownWords } };
    }
    case 'wordmark:clear-cache': {
      await onlineLookup.clear();
      return { ok: true, data: { cleared: true } };
    }
    default:
      return { ok: false, error: `unhandled: ${(message as { type: string }).type}` };
  }
}

function parseRequest(value: unknown): WordmarkRequest | null {
  return isWordmarkRequest(value) ? value : null;
}

/** service worker 只处理这几类消息，页面侧的两类由 content script 应答。 */
type BackgroundRequest = Exclude<
  WordmarkRequest,
  { type: 'wordmark:apply-settings' | 'wordmark:page-stats' }
>;

function isBackgroundRequest(request: WordmarkRequest): request is BackgroundRequest {
  return request.type !== 'wordmark:apply-settings' && request.type !== 'wordmark:page-stats';
}

const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;

runtime?.onInstalled?.addListener((details) => {
  if (details.reason !== 'install') return;
  void (async () => {
    try {
      await saveSettings(DEFAULT_SETTINGS);
    } catch {
      // 忽略：设置读不出来时会回落到默认值。
    }
  })();
});

runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  const request = parseRequest(message);
  if (request === null || !isBackgroundRequest(request)) return undefined;
  handleMessage(request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: String(error) } satisfies WordmarkResponse<null>);
    });
  // 必须返回 true 才能异步 sendResponse。
  return true;
});

export {};
