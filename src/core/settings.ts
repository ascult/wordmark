/**
 * 设置模型与持久化。
 *
 * 设计取舍：
 * - `settings` 体积小（< 2KB），放 `chrome.storage.sync`，多设备可同步；
 * - `knownWords` 会长到几千条，放 `chrome.storage.local`，避免 sync 配额（单键 8KB）；
 * - 在没有 `chrome.storage` 的环境（单测 / Node）自动退化为内存实现。
 */

import { isLevel, type Level } from './types.js';

export type RepeatMode = 'first' | 'all';
export type GlossStyle = 'subtle' | 'underline' | 'boxed';
export type OnlineProviderId = 'mymemory' | 'custom';

export interface OnlineSettings {
  /** 在线释义默认关闭：开启后会把单词发送给第三方服务。 */
  enabled: boolean;
  provider: OnlineProviderId;
  /** 自定义接口模板，需含 `{word}` 占位符。 */
  customUrl: string;
  /** 从 JSON 响应中取释义的路径，如 `responseData.translatedText`。 */
  customPath: string;
  timeoutMs: number;
  maxRequestsPerMinute: number;
}

/**
 * 语境义（AI 挑选义项）设置。
 *
 * 与 `online` 的区别：这里发出去的不是单个单词，而是**整句**——
 * 因为「哪个义项合语境」这件事只有看到句子才能判断。
 * 默认指向本机服务（`prototype/mt-align/xenc/serve.py`），因此数据不出本机；
 * 但既然会把句子发到 `endpoint`，就仍然默认关闭，由用户显式打开。
 */
export interface SenseSettings {
  /** 默认关闭。开启后会把**整句**发送到 endpoint。 */
  enabled: boolean;
  /** 本机打分服务地址，形如 `http://127.0.0.1:8317`。 */
  endpoint: string;
  timeoutMs: number;
  /** 单页最多请求多少个词：服务端是逐题前向，量太大就变成拖累。 */
  maxPerPage: number;
}

export interface Settings {
  /** 全局开关。 */
  enabled: boolean;
  /** 只标注该难度及更难的词，用来控制标注密度。 */
  annotateFrom: Level;
  /** 短于该长度的词不标注（默认 3，可滤掉 a / of / to）。 */
  minWordLength: number;
  /** 同一词元在本页标注一次还是每次都标。 */
  repeatMode: RepeatMode;
  /** 单页标注数量上限，防止极端页面卡顿。 */
  maxGlossesPerPage: number;
  /** 是否用 MutationObserver 处理无限滚动 / SPA 动态内容。 */
  dynamicContent: boolean;
  /** 释义中是否附带词性，如「孩子 n.」。 */
  showPos: boolean;
  /** 视觉样式。 */
  glossStyle: GlossStyle;
  online: OnlineSettings;
  /** 语境义挑选（本机小模型服务）。默认关闭。 */
  sense: SenseSettings;
  /** 命中这些 host 的站点完全关闭（支持 `example.com` 与 `*.example.com`）。 */
  blockedHosts: string[];
}

export const STORAGE_KEYS = {
  settings: 'wordmark:settings',
  knownWords: 'wordmark:knownWords',
} as const;

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  annotateFrom: 'cet4',
  minWordLength: 3,
  repeatMode: 'first',
  maxGlossesPerPage: 600,
  dynamicContent: true,
  showPos: false,
  glossStyle: 'subtle',
  online: {
    enabled: false,
    provider: 'mymemory',
    customUrl: '',
    customPath: 'responseData.translatedText',
    timeoutMs: 6000,
    maxRequestsPerMinute: 20,
  },
  sense: {
    enabled: false,
    endpoint: 'http://127.0.0.1:8317',
    // 单批 32 题、服务端约 61ms/题 → 约 2 秒；留 50% 余量
    timeoutMs: 3000,
    maxPerPage: 300,
  },
  blockedHosts: [],
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase();
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function sanitizeOnline(input: unknown): OnlineSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const provider = oneOf<OnlineProviderId>(raw['provider'], ['mymemory', 'custom'], 'mymemory');
  const customUrl = typeof raw['customUrl'] === 'string' ? raw['customUrl'].trim() : '';
  const customPath =
    typeof raw['customPath'] === 'string' && raw['customPath'].trim() !== ''
      ? raw['customPath'].trim()
      : DEFAULT_SETTINGS.online.customPath;
  return {
    enabled: raw['enabled'] === true,
    provider,
    customUrl,
    customPath,
    timeoutMs: clampInt(raw['timeoutMs'], 1000, 20_000, DEFAULT_SETTINGS.online.timeoutMs),
    maxRequestsPerMinute: clampInt(
      raw['maxRequestsPerMinute'],
      1,
      120,
      DEFAULT_SETTINGS.online.maxRequestsPerMinute,
    ),
  };
}

/**
 * 语境义端点是否落在「本机或局域网」。
 *
 * 整句正文会发往这个地址，所以「只发本机/局域网」是产品承诺（见
 * `docs/adr/0001-local-only-sentence-context.md`）。判定必须放在这一层：
 * 导入的 JSON 配置也走 `sanitizeSettings`，只把校验留在设置页 UI 上等于没有。
 */
export function isLocalEndpointHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') return false;
  if (host === 'localhost' || host === '::1') return true;
  // mDNS / 家庭网络：用主机名比记 IP 稳，且这两类名字解析不出局域网
  if (host.endsWith('.local') || host.endsWith('.home.arpa')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split('.').map(Number);
    const [a = -1, b = -1] = parts;
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    if (a === 127 || a === 10) return true; // 回环 / 私网
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  // IPv6 ULA fc00::/7。必须先确认它真是 IPv6 字面量：单标签主机名 `fc00` / `fcc0` 之类
  // 会落进同一个十六进制区间，但那是可被 DNS 解析的名字，不在白名单语义内。
  if (!host.includes(':')) return false;
  const firstHextet = host.split(':')[0] ?? '';
  if (/^[0-9a-f]{1,4}$/.test(firstHextet)) {
    return (Number.parseInt(firstHextet, 16) & 0xfe00) === 0xfc00;
  }
  return false;
}

/**
 * 校验 endpoint。
 *
 * 只接受 http/https、没有内嵌凭据、且 host 在本机/局域网之内的地址：
 * 这个值会被 `fetch` 直接使用，放任 `javascript:` / `data:` 之类的协议进来等于给自己开一个注入面；
 * 而放任公网 host 进来，就是让「整句不出本机」的承诺失效。
 * 结尾斜杠统一去掉，调用方拼 `/select` 时不用担心出现 `//`。
 */
export function sanitizeEndpoint(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
  if (url.username !== '' || url.password !== '') return fallback;
  if (!isLocalEndpointHost(url.hostname)) return fallback;
  return trimmed.replace(/\/+$/, '');
}

function sanitizeSense(input: unknown): SenseSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    enabled: raw['enabled'] === true,
    endpoint: sanitizeEndpoint(raw['endpoint'], DEFAULT_SETTINGS.sense.endpoint),
    timeoutMs: clampInt(raw['timeoutMs'], 500, 60_000, DEFAULT_SETTINGS.sense.timeoutMs),
    maxPerPage: clampInt(raw['maxPerPage'], 0, 5000, DEFAULT_SETTINGS.sense.maxPerPage),
  };
}

/** 把任意来源（旧版本存储 / 导入的 JSON）的输入收敛成合法设置。 */
export function sanitizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    enabled: raw['enabled'] !== false,
    annotateFrom: isLevel(raw['annotateFrom'])
      ? raw['annotateFrom']
      : DEFAULT_SETTINGS.annotateFrom,
    minWordLength: clampInt(raw['minWordLength'], 1, 12, DEFAULT_SETTINGS.minWordLength),
    repeatMode: oneOf<RepeatMode>(raw['repeatMode'], ['first', 'all'], DEFAULT_SETTINGS.repeatMode),
    maxGlossesPerPage: clampInt(
      raw['maxGlossesPerPage'],
      20,
      5000,
      DEFAULT_SETTINGS.maxGlossesPerPage,
    ),
    dynamicContent: raw['dynamicContent'] !== false,
    showPos: raw['showPos'] === true,
    glossStyle: oneOf<GlossStyle>(
      raw['glossStyle'],
      ['subtle', 'underline', 'boxed'],
      DEFAULT_SETTINGS.glossStyle,
    ),
    online: sanitizeOnline(raw['online']),
    sense: sanitizeSense(raw['sense']),
    blockedHosts: stringList(raw['blockedHosts'], 500),
  };
}

/** 合并部分设置（用于选项页 / 弹窗的局部更新）。 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const base = current as unknown as Record<string, unknown>;
  const next = (patch ?? {}) as Record<string, unknown>;
  return sanitizeSettings({
    ...base,
    ...next,
    online: { ...(base['online'] as object), ...((next['online'] as object) ?? {}) },
    sense: { ...(base['sense'] as object), ...((next['sense'] as object) ?? {}) },
  });
}

/** host 是否被屏蔽规则命中。`*.example.com` 只匹配子域，`example.com` 同时匹配自身与子域。 */
export function isHostBlocked(host: string, patterns: readonly string[]): boolean {
  const target = host.trim().toLowerCase().replace(/^www\./, '');
  if (target === '') return false;
  for (const pattern of patterns) {
    const rule = pattern.trim().toLowerCase().replace(/^www\./, '');
    if (rule === '') continue;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(2);
      if (suffix !== '' && target.endsWith(`.${suffix}`)) return true;
      continue;
    }
    if (target === rule || target.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 存储层                                                              */
/* ------------------------------------------------------------------ */

/** chrome.storage.area 的结构类型;没有扩展环境时由内存实现替代。 */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

const memory = new Map<string, unknown>();

const memoryArea: StorageArea = {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) {
      if (memory.has(key)) out[key] = memory.get(key);
    }
    return out;
  },
  async set(items) {
    for (const [key, value] of Object.entries(items)) memory.set(key, value);
  },
  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) memory.delete(key);
  },
};

/** 拿一个可用的 storage area；没有扩展环境时退化到内存。 */
export function storageArea(name: 'sync' | 'local'): StorageArea {
  const api = typeof chrome !== 'undefined' ? chrome.storage : undefined;
  const area = api?.[name];
  if (area && typeof area.get === 'function' && typeof area.set === 'function') {
    return area as unknown as StorageArea;
  }
  return memoryArea;
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await storageArea('sync').get(STORAGE_KEYS.settings);
    return sanitizeSettings(stored[STORAGE_KEYS.settings]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await storageArea('sync').set({ [STORAGE_KEYS.settings]: settings });
}

export async function updateSettings(patch: unknown): Promise<Settings> {
  const next = mergeSettings(await loadSettings(), patch);
  await saveSettings(next);
  return next;
}

export async function loadKnownWords(): Promise<string[]> {
  try {
    const stored = await storageArea('local').get(STORAGE_KEYS.knownWords);
    return stringList(stored[STORAGE_KEYS.knownWords], 20_000);
  } catch {
    return [];
  }
}

export async function saveKnownWords(words: readonly string[]): Promise<string[]> {
  const next = stringList(words, 20_000);
  await storageArea('local').set({ [STORAGE_KEYS.knownWords]: next });
  return next;
}

export async function addKnownWord(word: string): Promise<string[]> {
  const current = await loadKnownWords();
  if (current.includes(word.toLowerCase())) return current;
  return saveKnownWords([...current, word]);
}

export async function removeKnownWord(word: string): Promise<string[]> {
  const current = await loadKnownWords();
  const target = word.toLowerCase();
  return saveKnownWords(current.filter((item) => item !== target));
}

/** 监听设置 / 已知词变化；返回取消订阅函数。没有 chrome.storage 时是空操作。 */
export function onStorageChanged(
  handler: (change: { settings?: Settings; knownWords?: string[] }) => void,
): () => void {
  const api = typeof chrome !== 'undefined' ? chrome.storage : undefined;
  if (!api?.onChanged || typeof api.onChanged.addListener !== 'function') {
    return () => {};
  }
  const listener = (
    changes: Record<string, StorageChange>,
    areaName: string,
  ): void => {
    const payload: { settings?: Settings; knownWords?: string[] } = {};
    if (areaName === 'sync' && STORAGE_KEYS.settings in changes) {
      payload.settings = sanitizeSettings(changes[STORAGE_KEYS.settings]?.newValue);
    }
    if (areaName === 'local' && STORAGE_KEYS.knownWords in changes) {
      payload.knownWords = stringList(changes[STORAGE_KEYS.knownWords]?.newValue, 20_000);
    }
    if (payload.settings !== undefined || payload.knownWords !== undefined) handler(payload);
  };
  api.onChanged.addListener(listener);
  return () => api.onChanged.removeListener(listener);
}
