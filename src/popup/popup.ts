/**
 * 弹窗：当前站点的开关、生词线，以及本页标注统计。
 *
 * 关键设计：**不读 `tab.url`**。
 * Chrome 只在扩展拥有该标签页的 host 权限（`tabs` / `activeTab` / 对应
 * host_permissions）时才暴露 `tab.url`——content_scripts.matches 不算。
 * 少了它弹窗只会拿到空串，于是每个站点都显示「不支持」。
 * 与其为了一句站点名去申请「读取浏览历史」级别的权限，不如直接问内容脚本：
 * 它本来就知道自己在哪个站点、标注了多少。顺带的好处是这条路径在无头
 * 浏览器里也能完整验证（弹窗不需要真实点击扩展图标才拿得到信息）。
 *
 * 内容脚本答不上来（chrome:// 页面、扩展页）就说明该页不被支持。
 */

import { sendRequest, type PageStats, type StateSnapshot } from '../core/messages.js';
import type { Level } from '../core/types.js';

function $<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少元素 #${id}`);
  return element as T;
}

async function activeTabId(): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

/** 问内容脚本要本页信息；页面里没有内容脚本时返回 null。 */
async function fetchPageInfo(tabId: number | undefined): Promise<PageStats | null> {
  if (tabId === undefined) return null;
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: 'wordmark:page-stats',
    })) as { ok?: boolean; data?: PageStats } | undefined;
    return response?.ok ? (response.data ?? null) : null;
  } catch {
    // 目标页没有内容脚本（chrome://、扩展页、未注入的新标签页）
    return null;
  }
}

function renderStats(info: PageStats | null): void {
  $('stat-glossed').textContent = info ? String(info.glossed) : '–';
  $('stat-unique').textContent = info ? String(info.unique) : '–';
  $('stat-unresolved').textContent = info ? String(info.unresolved) : '–';
  $('stat-contextual').textContent = info ? String(info.contextual) : '–';
}

/**
 * 语境义是**静默回退**的：服务没起、超时、词不在义项表里，页面表现完全一样。
 * 所以「通没通」必须在这里说清楚——否则用户没有任何办法知道这个功能有没有在工作。
 */
function renderSenseState(enabled: boolean, info: PageStats | null): void {
  const node = $('sense-state');
  if (!enabled) {
    node.textContent = '语境义：未开启（可在设置页启用）';
    return;
  }
  if (info === null) {
    node.textContent = '语境义：当前页面不支持';
    return;
  }
  node.textContent = info.senseReachable
    ? `语境义：服务已连通，本页替换 ${info.contextual} 处`
    : '语境义：服务不可达，本页按词典义显示';
}

async function main(): Promise<void> {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const tabId = await activeTabId();
  const info = await fetchPageInfo(tabId);
  const host = info?.host ?? '';
  const supported = info !== null;

  $('site-host').textContent = host === '' ? '（当前页面不支持）' : host;

  const res = await sendRequest<StateSnapshot>({ type: 'wordmark:get-state', host });
  if (!res.ok) {
    $('hint').textContent = '无法读取设置，请重新打开扩展。';
    $('sense-state').textContent = '语境义：无法读取设置';
    renderStats(info);
    return;
  }
  const state = res.data;

  const globalToggle = $<HTMLInputElement>('toggle-global');
  const siteToggle = $<HTMLInputElement>('toggle-site');
  const levelSelect = $<HTMLSelectElement>('select-level');

  globalToggle.checked = state.settings.enabled;
  siteToggle.checked = !state.hostBlocked;
  siteToggle.disabled = !supported;
  siteToggle.title = supported ? '' : '当前页面不支持内容脚本';
  levelSelect.value = state.settings.annotateFrom;
  renderSenseState(state.settings.sense.enabled, info);

  globalToggle.addEventListener('change', () => {
    void sendRequest({ type: 'wordmark:set-settings', patch: { enabled: globalToggle.checked } });
  });

  levelSelect.addEventListener('change', () => {
    void sendRequest({
      type: 'wordmark:set-settings',
      patch: { annotateFrom: levelSelect.value as Level },
    });
  });

  siteToggle.addEventListener('change', () => {
    if (host === '') return;
    void sendRequest({
      type: 'wordmark:set-site-enabled',
      host,
      enabled: siteToggle.checked,
    });
  });

  $('btn-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
  });

  $('btn-rescan').addEventListener('click', () => {
    void (async () => {
      if (tabId === undefined) return;
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'wordmark:apply-settings' });
      } catch {
        // 页面没有内容脚本，忽略。
      }
      const fresh = await fetchPageInfo(tabId);
      renderStats(fresh);
      renderSenseState(state.settings.sense.enabled, fresh);
    })();
  });

  if (!supported) {
    $('hint').textContent = '当前页面（如新标签页、chrome:// 页面）不支持内容脚本。';
    $('sense-state').textContent = '语境义：当前页面不支持';
    renderStats(null);
    return;
  }

  renderStats(info);
  renderSenseState(state.settings.sense.enabled, info);
}

void main();
