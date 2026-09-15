/**
 * 设置页。
 *
 * 所有写操作都经 service worker（消息协议），因此设置只有一个写入点，
 * content script 只靠 `chrome.storage.onChanged` 就能同步所有标签页。
 * 表单绑定用一张声明表驱动，避免十几份重复的事件处理代码。
 */

import dictJson from '../data/dict.zh.json';
import { sendRequest, type StateSnapshot } from '../core/messages.js';
import { DEFAULT_SETTINGS, isLocalEndpointHost, sanitizeSettings, type Settings } from '../core/settings.js';
import { LEVELS, type DictEntry } from '../core/types.js';

const DICT = dictJson as unknown as DictEntry[];

interface Binding {
  id: string;
  kind: 'checkbox' | 'number' | 'select';
  read: (settings: Settings) => string | number | boolean;
  /** 变更时提交给 service worker 的补丁。 */
  patch: (value: string | number | boolean) => Record<string, unknown>;
}

const BINDINGS: Binding[] = [
  {
    id: 'enabled',
    kind: 'checkbox',
    read: (s) => s.enabled,
    patch: (v) => ({ enabled: Boolean(v) }),
  },
  {
    id: 'annotateFrom',
    kind: 'select',
    read: (s) => s.annotateFrom,
    patch: (v) => ({ annotateFrom: String(v) }),
  },
  {
    id: 'repeatMode',
    kind: 'select',
    read: (s) => s.repeatMode,
    patch: (v) => ({ repeatMode: String(v) }),
  },
  {
    id: 'minWordLength',
    kind: 'number',
    read: (s) => s.minWordLength,
    patch: (v) => ({ minWordLength: Number(v) }),
  },
  {
    id: 'maxGlossesPerPage',
    kind: 'number',
    read: (s) => s.maxGlossesPerPage,
    patch: (v) => ({ maxGlossesPerPage: Number(v) }),
  },
  {
    id: 'glossStyle',
    kind: 'select',
    read: (s) => s.glossStyle,
    patch: (v) => ({ glossStyle: String(v) }),
  },
  {
    id: 'showPos',
    kind: 'checkbox',
    read: (s) => s.showPos,
    patch: (v) => ({ showPos: Boolean(v) }),
  },
  {
    id: 'dynamicContent',
    kind: 'checkbox',
    read: (s) => s.dynamicContent,
    patch: (v) => ({ dynamicContent: Boolean(v) }),
  },
  {
    id: 'online-enabled',
    kind: 'checkbox',
    read: (s) => s.online.enabled,
    patch: (v) => ({ online: { enabled: Boolean(v) } }),
  },
  {
    id: 'online-provider',
    kind: 'select',
    read: (s) => s.online.provider,
    patch: (v) => ({ online: { provider: String(v) } }),
  },
  {
    id: 'online-customUrl',
    kind: 'select',
    read: (s) => s.online.customUrl,
    patch: (v) => ({ online: { customUrl: String(v) } }),
  },
  {
    id: 'online-customPath',
    kind: 'select',
    read: (s) => s.online.customPath,
    patch: (v) => ({ online: { customPath: String(v) } }),
  },
  {
    id: 'online-timeoutMs',
    kind: 'number',
    read: (s) => s.online.timeoutMs,
    patch: (v) => ({ online: { timeoutMs: Number(v) } }),
  },
  {
    id: 'online-maxRequestsPerMinute',
    kind: 'number',
    read: (s) => s.online.maxRequestsPerMinute,
    patch: (v) => ({ online: { maxRequestsPerMinute: Number(v) } }),
  },
  {
    id: 'sense-enabled',
    kind: 'checkbox',
    read: (s) => s.sense.enabled,
    patch: (v) => ({ sense: { enabled: Boolean(v) } }),
  },
  {
    id: 'sense-endpoint',
    kind: 'select',
    read: (s) => s.sense.endpoint,
    patch: (v) => ({ sense: { endpoint: String(v) } }),
  },
  {
    id: 'sense-timeoutMs',
    kind: 'number',
    read: (s) => s.sense.timeoutMs,
    patch: (v) => ({ sense: { timeoutMs: Number(v) } }),
  },
  {
    id: 'sense-maxPerPage',
    kind: 'number',
    read: (s) => s.sense.maxPerPage,
    patch: (v) => ({ sense: { maxPerPage: Number(v) } }),
  },
];

/**
 * 文本输入（URL / 路径）不需要即时提交，用『change 时提交』。
 * kind 标成 select 是因为它们都是 value 型控件。
 */
const TEXT_IDS = new Set(['online-customUrl', 'online-customPath', 'sense-endpoint']);

const state = {
  settings: DEFAULT_SETTINGS as Settings,
  knownWords: [] as string[],
};

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素 #${id}`);
  return element as T;
}

let savedTimer: ReturnType<typeof setTimeout> | null = null;

function flashSaved(): void {
  const pill = $('save-state');
  pill.setAttribute('data-visible', '1');
  if (savedTimer !== null) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => pill.setAttribute('data-visible', '0'), 1400);
}

function log(message: string): void {
  const box = $('log');
  box.hidden = false;
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const lines = `${box.textContent ?? ''}[${stamp}] ${message}\n`.split('\n');
  box.textContent = lines.slice(-21).join('\n');
}

/**
 * 收到设置后一律先过 `sanitizeSettings`。
 *
 * 为什么不能直接信任来源：service worker 返回的确实是收敛过的，
 * 但这个页面只是「设置的一个消费者」，将来换存储、导入配置、
 * 或者降级到旧版本时缺字段，`read` 就会在 `s.sense.enabled` 上直接抛
 * （UI 冒烟测试正是这样抓到过一次）。收敛一次的成本可以忽略。
 */
function adoptSettings(input: unknown): void {
  state.settings = sanitizeSettings(input);
}

async function patchSettings(patch: unknown, note?: string): Promise<void> {
  const res = await sendRequest<{ settings: Settings }>({ type: 'wordmark:set-settings', patch });
  if (!res.ok) {
    log(`保存失败：${res.error}`);
    return;
  }
  adoptSettings(res.data.settings);
  flashSaved();
  render();
  if (note) log(note);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderControls(): void {
  for (const binding of BINDINGS) {
    const element = $<HTMLInputElement & HTMLSelectElement>(binding.id);
    const value = binding.read(state.settings);
    if (binding.kind === 'checkbox') element.checked = Boolean(value);
    else element.value = String(value);
  }
  const custom = state.settings.online.provider === 'custom';
  for (const field of document.querySelectorAll<HTMLElement>('[data-when="custom"]')) {
    field.hidden = !custom;
  }
}

function renderChips(containerId: string, countId: string, values: readonly string[], onRemove: (value: string) => void): void {
  const container = $(containerId);
  $(countId).textContent = String(values.length);
  container.textContent = '';
  const LIMIT = 400;
  for (const value of values.slice(0, LIMIT)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const label = document.createElement('span');
    label.textContent = value;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `移除 ${value}`;
    remove.addEventListener('click', () => onRemove(value));
    chip.append(label, remove);
    container.appendChild(chip);
  }
  if (values.length > LIMIT) {
    const more = document.createElement('span');
    more.className = 'chip';
    more.textContent = `还有 ${values.length - LIMIT} 项…`;
    container.appendChild(more);
  }
}

function renderDictStats(): void {
  $('dict-total').textContent = String(DICT.length);
  for (const level of LEVELS) {
    const count = DICT.filter((entry) => entry.level === level).length;
    $(`dict-${level}`).textContent = String(count);
  }
}

function render(): void {
  renderControls();
  renderChips('known-list', 'known-count', state.knownWords, (word) => {
    void setKnownWords(state.knownWords.filter((item) => item !== word));
  });
  renderChips('blocked-list', 'blocked-count', state.settings.blockedHosts, (host) => {
    void patchSettings({ blockedHosts: state.settings.blockedHosts.filter((item) => item !== host) });
  });
}

/* ------------------------------------------------------------------ */
/* 已知词 / 站点列表                                                    */
/* ------------------------------------------------------------------ */

function parseWords(input: string): string[] {
  return input
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z][a-z'-]*$/.test(item));
}

async function setKnownWords(words: readonly string[]): Promise<void> {
  const res = await sendRequest<{ knownWords: string[] }>({
    type: 'wordmark:set-known-words',
    words: [...words],
  });
  if (!res.ok) {
    log(`已知词表保存失败：${res.error}`);
    return;
  }
  state.knownWords = res.data.knownWords;
  flashSaved();
  render();
}

/* ------------------------------------------------------------------ */
/* 权限                                                                */
/* ------------------------------------------------------------------ */

function originOf(url: string): string | null {
  if (!url.includes('{word}')) return null;
  try {
    const parsed = new URL(url.replace('{word}', 'test'));
    if (parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

async function refreshPermissionHint(): Promise<void> {
  const hint = $('perm-hint');
  const button = $<HTMLButtonElement>('btn-permission');
  const origin = originOf(state.settings.online.customUrl);
  if (origin === null) {
    hint.textContent = '填入合法的 https 接口地址后即可申请权限。';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  hint.textContent = granted
    ? `已授权访问 ${origin}`
    : `尚未授权访问 ${origin}，未授权时该接口不会被调用。`;
  button.textContent = granted ? '重新确认' : '授予权限';
}

/**
 * 本机打分服务地址 → 权限 origin。
 *
 * 与在线接口不同，这里**允许 http**：服务跑在本机上，回环没有 TLS 可言。
 * 「本机/局域网」的判定复用设置收敛层的 `isLocalEndpointHost`——两处各写一套规则，
 * 迟早会分叉，而这一层只是 UI 提示，真正拦住导入配置的是设置收敛层。
 */
export function originOfLocalEndpoint(endpoint: string): string | null {
  const trimmed = endpoint.trim();
  if (trimmed === '') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username !== '' || parsed.password !== '') return null;
    // 只允许本机与局域网：整句会发往这个地址（见 docs/adr/0001）
    if (!isLocalEndpointHost(parsed.hostname)) return null;
    return `${parsed.origin}/*`;
  } catch {
    return null;
  }
}

async function refreshSensePermissionHint(): Promise<void> {
  const hint = $('sense-perm-hint');
  const button = $<HTMLButtonElement>('btn-sense-permission');
  const origin = originOfLocalEndpoint(state.settings.sense.endpoint);
  if (origin === null) {
    hint.textContent = '填入合法的本机地址（如 http://127.0.0.1:8317）后即可申请权限。';
    button.disabled = true;
    return;
  }
  button.disabled = false;
  const granted = await chrome.permissions.contains({ origins: [origin] });
  hint.textContent = granted
    ? `已授权访问 ${origin}`
    : `尚未授权访问 ${origin}，未授权时语境义不会被挑选。`;
  button.textContent = granted ? '重新确认' : '授予权限';
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

function exportConfig(): void {
  const payload = {
    app: 'wordmark',
    version: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    knownWords: state.knownWords,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'wordmark-config.json';
  anchor.click();
  URL.revokeObjectURL(url);
  log(`已导出配置（${state.knownWords.length} 个已知词）`);
}

async function importConfig(file: File): Promise<void> {
  try {
    const parsed = JSON.parse(await file.text()) as {
      settings?: unknown;
      knownWords?: unknown;
    };
    await patchSettings(parsed.settings ?? {}, '已导入设置');
    const words = Array.isArray(parsed.knownWords)
      ? parsed.knownWords.filter((item): item is string => typeof item === 'string')
      : [];
    await setKnownWords(words);
    log(`已导入 ${words.length} 个已知词`);
  } catch (error) {
    log(`导入失败：${String(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function bindEvents(): void {
  for (const binding of BINDINGS) {
    const element = $<HTMLInputElement & HTMLSelectElement>(binding.id);
    element.addEventListener('change', () => {
      void (async () => {
        const raw = binding.kind === 'checkbox' ? element.checked : element.value;
        // 必须先落盘再刷新权限提示：提示读的是 state.settings，
        // 提前读会拿到改动前的旧值（改了地址却还显示上一次的授权状态）。
        await patchSettings(binding.patch(raw));
        if (binding.id === 'online-provider' || TEXT_IDS.has(binding.id)) {
          await refreshPermissionHint();
        }
        if (binding.id === 'sense-endpoint') {
          await refreshSensePermissionHint();
        }
      })();
    });
  }

  $('known-add').addEventListener('click', () => {
    const input = $<HTMLInputElement>('known-input');
    const words = parseWords(input.value);
    if (words.length === 0) {
      log('没有解析到合法单词（只接受英文字母）');
      return;
    }
    input.value = '';
    void setKnownWords([...new Set([...state.knownWords, ...words])]);
  });

  $('known-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $<HTMLButtonElement>('known-add').click();
  });

  $('known-clear').addEventListener('click', () => {
    if (!confirm('确定清空已知词表？清空后这些词会重新被标注。')) return;
    void setKnownWords([]);
  });

  $('blocked-add').addEventListener('click', () => {
    const input = $<HTMLInputElement>('blocked-input');
    const host = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host === '') return;
    input.value = '';
    void patchSettings({ blockedHosts: [...new Set([...state.settings.blockedHosts, host])] });
  });

  $('blocked-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $<HTMLButtonElement>('blocked-add').click();
  });

  $('btn-permission').addEventListener('click', () => {
    void (async () => {
      const origin = originOf(state.settings.online.customUrl);
      if (origin === null) return;
      // 必须由用户手势触发，这里正好在 click 回调内。
      const granted = await chrome.permissions.request({ origins: [origin] });
      log(granted ? `已授予 ${origin}` : `未授予 ${origin} 权限`);
      await refreshPermissionHint();
    })();
  });

  $('btn-sense-permission').addEventListener('click', () => {
    void (async () => {
      const origin = originOfLocalEndpoint(state.settings.sense.endpoint);
      if (origin === null) return;
      const granted = await chrome.permissions.request({ origins: [origin] });
      log(granted ? `已授予本机服务 ${origin}` : `未授予 ${origin} 权限`);
      await refreshSensePermissionHint();
    })();
  });

  $('btn-export').addEventListener('click', exportConfig);

  $('btn-import').addEventListener('click', () => $<HTMLInputElement>('import-file').click());

  $('import-file').addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importConfig(file);
    input.value = '';
  });

  $('btn-clear-cache').addEventListener('click', () => {
    void (async () => {
      const res = await sendRequest<{ cleared: boolean }>({ type: 'wordmark:clear-cache' });
      log(res.ok && res.data.cleared ? '已清空在线查询缓存' : '缓存清理失败');
    })();
  });

  $('btn-reset').addEventListener('click', () => {
    if (!confirm('恢复默认设置？已知词表会保留。')) return;
    void patchSettings({ ...DEFAULT_SETTINGS }, '已恢复默认设置');
  });
}

async function main(): Promise<void> {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  renderDictStats();

  const res = await sendRequest<StateSnapshot>({ type: 'wordmark:get-state', host: '' });
  if (!res.ok) {
    log('无法连接 service worker，请重新打开设置页');
    return;
  }
  adoptSettings(res.data.settings);
  state.knownWords = res.data.knownWords;
  $<HTMLSelectElement>('annotateFrom').value = state.settings.annotateFrom;

  render();
  bindEvents();
  await Promise.all([refreshPermissionHint(), refreshSensePermissionHint()]);
}

void main();
