/**
 * 弹窗 / 设置页的冒烟测试。
 *
 * 单测覆盖不到 UI：HTML 里的 id 与 TS 里的 id 对不上、消息协议字段写错，
 * 都只会在用户真正打开页面时炸掉。这里用 jsdom + 假的 chrome API
 * 真实加载 dist/options.html 与 dist/popup.html（连 <script src> 一起），
 * 验证页面能渲染、能读写设置、能发对消息，并且没有任何未捕获异常。
 *
 * 用法：npm run build:prod && npm run smoke:ui
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];
const notes = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` —— ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`);
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

const BASE_SETTINGS = {
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
    timeoutMs: 8000,
    maxPerPage: 300,
  },
  blockedHosts: [],
};

/**
 * 与真实 service worker 的 `mergeSettings` 对齐的补丁合并：
 * 顶层覆盖，**每个对象型字段再深合并一层**（online / sense …）。
 * 之前这里只硬编码合并 `online`，新加 `sense` 后就不再反映真实行为，
 * 会让冒烟测试悄悄失去覆盖。
 */
function mergePatch(current, patch) {
  const next = { ...current, ...(patch ?? {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const base = current?.[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      base !== null &&
      typeof base === 'object'
    ) {
      next[key] = { ...base, ...value };
    }
  }
  return next;
}

/**
 * 假 chrome：只实现页面真正用到的那几个 API，并记录收到的消息，
 * 这样「UI 发出的请求」就是可断言的对象。
 */
function createChromeMock(options) {  const state = {
    settings: structuredClone(BASE_SETTINGS),
    knownWords: [],
    permissionGranted: false,
    optionsOpened: false,
    requests: [],
    errors: [],
  };

  const handle = async (request) => {
    state.requests.push(request ? { ...request, channel: 'runtime' } : { channel: 'runtime' });
    switch (request?.type) {
      case 'wordmark:get-state':
        return {
          ok: true,
          data: {
            settings: state.settings,
            knownWords: state.knownWords,
            hostBlocked: false,
          },
        };
      case 'wordmark:set-settings':
        state.settings = mergePatch(state.settings, request.patch);
        return { ok: true, data: { settings: state.settings } };
      case 'wordmark:set-known-words':
        state.knownWords = request.words;
        return { ok: true, data: { knownWords: state.knownWords } };
      case 'wordmark:set-site-enabled':
        state.settings = {
          ...state.settings,
          blockedHosts: request.enabled ? [] : ['example.com'],
        };
        return { ok: true, data: { settings: state.settings } };
      case 'wordmark:mark-known':
        state.knownWords = [...new Set([...state.knownWords, request.word])];
        return { ok: true, data: { knownWords: state.knownWords } };
      case 'wordmark:clear-cache':
        return { ok: true, data: { cleared: true } };
      default:
        return { ok: false, error: `unexpected: ${request?.type}` };
    }
  };

  const chromeMock = {
    runtime: {
      getManifest: () => ({ version: options.version }),
      sendMessage: (request) => handle(request),
      openOptionsPage: () => {
        state.optionsOpened = true;
      },
      onMessage: { addListener: () => {} },
      lastError: undefined,
    },
    tabs: {
      query: async () => [{ id: 1, url: options.tabUrl }],
      sendMessage: async (_tabId, request) => {
        // 弹窗 → content script 走的是 tabs.sendMessage，与 runtime 消息区分开
        state.requests.push(request ? { ...request, channel: 'tab' } : { channel: 'tab' });
        if (request?.type === 'wordmark:page-stats') {
          // host 由内容脚本提供——弹窗不再依赖 tab.url（那需要额外权限）
          return {
            ok: true,
            data: { host: 'example.com', glossed: 12, unique: 7, unresolved: 3, contextual: 5, sense: 'ok', active: true },
          };
        }
        return { ok: true, data: null };
      },
    },
    permissions: {
      contains: async () => state.permissionGranted,
      request: async () => {
        state.permissionGranted = true;
        return true;
      },
    },
    storage: {
      sync: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };

  return { chromeMock, state };
}

async function loadPage(file, options) {
  const { chromeMock, state } = createChromeMock(options);
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => {
    state.errors.push(`jsdomError: ${error.message}`);
  });
  virtualConsole.on('error', (...args) => {
    state.errors.push(`console.error: ${args.join(' ')}`);
  });

  const dom = await JSDOM.fromFile(path.join(DIST, file), {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.chrome = chromeMock;
      // 导出配置 / 重置确认用得到，jsdom 默认不实现
      window.confirm = () => true;
      window.URL.createObjectURL = () => 'blob:mock';
      window.URL.revokeObjectURL = () => {};
      window.addEventListener('error', (event) => {
        state.errors.push(`uncaught: ${event.message}`);
      });
      window.addEventListener('unhandledrejection', (event) => {
        state.errors.push(`unhandledrejection: ${String(event.reason)}`);
      });
    },
  });

  // 让 <script defer> 跑完
  await waitFor(() => dom.window.document.readyState === 'complete', 2000);
  // 让页面自己的 async main() 落地
  await sleep(60);
  return { dom, state };
}

/** 页面 → service worker 的消息（chrome.runtime.sendMessage）。 */
const requestsOf = (state, type) =>
  state.requests.filter((request) => request.channel === 'runtime' && request.type === type);

/** 弹窗 → content script 的消息（chrome.tabs.sendMessage）。 */
const tabRequestsOf = (state, type) =>
  state.requests.filter((request) => request.channel === 'tab' && request.type === type);

function report(label) {
  if (failures.length > 0) {
    console.error(`\n✗ ${label} 失败（${failures.length} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  for (const note of notes) console.log(`  · ${note}`);
  console.log(`\n✓ ${label}通过：页面可渲染、消息与设置读写正确、无未捕获异常`);
}

/* ------------------------------ 设置页 ------------------------------ */

async function checkOptions(version) {
  console.log('设置页冒烟测试（加载 dist/options.html）');
  const { dom, state } = await loadPage('options.html', {
    version,
    tabUrl: 'https://example.com/notes',
  });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);

  const ready = await waitFor(() => $('dict-total')?.textContent !== '–');
  check('页面脚本执行完成并渲染词表统计', ready);
  if (!ready) {
    report('设置页冒烟测试');
    return;
  }

  check('版号来自 manifest', $('version')?.textContent === `v${version}`, $('version')?.textContent);
  check('离线词条总数已渲染', Number($('dict-total')?.textContent) > 400, $('dict-total')?.textContent);
  check(
    '四档难度统计都有数字',
    ['cet4', 'cet6', 'ielts', 'gre'].every((level) => Number($(`dict-${level}`)?.textContent) > 0),
  );

  check('表单回填当前设置', $('annotateFrom')?.value === 'cet4', $('annotateFrom')?.value);
  check('开关回填当前设置', $('enabled')?.checked === true);
  check('初始已知词表为空', $('known-count')?.textContent === '0');
  check('初始站点规则为空', $('blocked-count')?.textContent === '0');

  // 只有选了自定义接口，才显示 URL / 路径 / 权限三行
  check(
    'MyMemory 模式下隐藏自定义接口字段',
    [...document.querySelectorAll('[data-when="custom"]')].every((field) => field.hidden === true),
  );

  // 改「生词线」应该发出一条 set-settings
  $('annotateFrom').value = 'gre';
  $('annotateFrom').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  const levelPatch = requestsOf(state, 'wordmark:set-settings').at(-1);
  check(
    '修改生词线发出 set-settings',
    levelPatch?.patch?.annotateFrom === 'gre',
    JSON.stringify(levelPatch?.patch),
  );

  // 切到自定义接口：字段出现，且提示未授权
  $('online-provider').value = 'custom';
  $('online-provider').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  check(
    '切到自定义接口后显示相关字段',
    [...document.querySelectorAll('[data-when="custom"]')].every((field) => field.hidden === false),
  );
  check(
    '未填地址时权限按钮禁用',
    $('btn-permission')?.disabled === true,
    $('perm-hint')?.textContent,
  );

  $('online-customUrl').value = 'https://api.example.com/dict?q={word}';
  $('online-customUrl').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  check(
    '填入合法地址后提示未授权',
    ($('perm-hint')?.textContent ?? '').includes('尚未授权'),
    $('perm-hint')?.textContent,
  );

  $('btn-permission')?.dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  check('点击授予权限后提示已授权', ($('perm-hint')?.textContent ?? '').includes('已授权'), $('perm-hint')?.textContent);

  // 已知词：输入 → 添加 → 渲染成 chip
  $('known-input').value = 'Ephemeral, biodiversity';
  $('known-add').dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  const knownRequest = requestsOf(state, 'wordmark:set-known-words').at(-1);
  check(
    '添加已知词发出规范化后的词表',
    JSON.stringify(knownRequest?.words) === JSON.stringify(['ephemeral', 'biodiversity']),
    JSON.stringify(knownRequest?.words),
  );
  check('已知词渲染为 chip 并更新计数', $('known-count')?.textContent === '2');
  const chips = document.querySelectorAll('#known-list .chip');
  check('chip 数量与词表一致', chips.length === 2, String(chips.length));

  // 点 chip 上的 × 移除
  chips[0]?.querySelector('button')?.dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  check(
    '点击 × 移除单个已知词',
    JSON.stringify(requestsOf(state, 'wordmark:set-known-words').at(-1)?.words) ===
      JSON.stringify(['biodiversity']),
  );

  // 站点规则
  $('blocked-input').value = 'https://news.example.com/section';
  $('blocked-add').dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  check(
    '站点规则去掉协议与路径后入库',
    JSON.stringify(requestsOf(state, 'wordmark:set-settings').at(-1)?.patch?.blockedHosts) ===
      JSON.stringify(['news.example.com']),
    JSON.stringify(requestsOf(state, 'wordmark:set-settings').at(-1)?.patch),
  );

  // 清空缓存
  $('btn-clear-cache').dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  check('清空缓存发出对应消息', requestsOf(state, 'wordmark:clear-cache').length === 1);

  // 恢复默认
  $('btn-reset').dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  const resetPatch = requestsOf(state, 'wordmark:set-settings').at(-1)?.patch;
  check(
    '恢复默认设置带上完整默认值',
    resetPatch?.annotateFrom === 'cet4' && resetPatch?.minWordLength === 3,
    JSON.stringify(resetPatch),
  );

  check('全程没有未捕获异常', state.errors.length === 0, state.errors.slice(0, 3).join(' | '));
  notes.push(`设置页发出来自 UI 的消息 ${requestsOf(state, 'wordmark:set-settings').length + requestsOf(state, 'wordmark:set-known-words').length + 1} 条`);
  dom.window.close();
  report('设置页冒烟测试');
}

/* ------------------------------ 弹窗 ------------------------------ */

async function checkPopup(version) {
  failures.length = 0;
  console.log('\n弹窗冒烟测试（加载 dist/popup.html）');
  const { dom, state } = await loadPage('popup.html', {
    version,
    tabUrl: 'https://example.com/notes',
  });
  const { document } = dom.window;
  const $ = (id) => document.getElementById(id);

  const ready = await waitFor(() => $('stat-glossed')?.textContent === '12');
  check('读取并渲染本页统计', ready, `glossed=${$('stat-glossed')?.textContent}`);
  if (!ready) {
    report('弹窗冒烟测试');
    return;
  }

  check('版本号已渲染', $('version')?.textContent === `v${version}`, $('version')?.textContent);
  check(
    '统计都来自 content script',
    $('stat-unique')?.textContent === '7' &&
      $('stat-unresolved')?.textContent === '3' &&
      $('stat-contextual')?.textContent === '5',
    `unique=${$('stat-unique')?.textContent} unresolved=${$('stat-unresolved')?.textContent} contextual=${$('stat-contextual')?.textContent}`,
  );
  check(
    '语境义未开启时说清楚是「未开启」，而不是让人以为坏了',
    $('sense-state')?.textContent === '语境义：未开启（可在设置页启用）',
    $('sense-state')?.textContent,
  );
  check('显示当前站点', $('site-host')?.textContent === 'example.com', $('site-host')?.textContent);
  check('总开关回填设置', $('toggle-global')?.checked === true);
  check('本站开关回填设置', $('toggle-site')?.checked === true && $('toggle-site')?.disabled === false);
  check('生词线回填设置', $('select-level')?.value === 'cet4', $('select-level')?.value);

  // 关掉本站开关：应发出 set-site-enabled，并要求页面重新应用设置
  $('toggle-site').checked = false;
  $('toggle-site').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  const siteRequest = requestsOf(state, 'wordmark:set-site-enabled').at(-1);
  check(
    '关闭本站发出 set-site-enabled',
    siteRequest?.host === 'example.com' && siteRequest?.enabled === false,
    JSON.stringify(siteRequest),
  );

  // 关掉总开关：应发出 set-settings
  $('toggle-global').checked = false;
  $('toggle-global').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  check(
    '关闭总开关发出 set-settings',
    requestsOf(state, 'wordmark:set-settings').at(-1)?.patch?.enabled === false,
  );

  // 改生词线
  $('select-level').value = 'ielts';
  $('select-level').dispatchEvent(new dom.window.Event('change'));
  await sleep(30);
  check(
    '修改生词线发出 set-settings',
    requestsOf(state, 'wordmark:set-settings').at(-1)?.patch?.annotateFrom === 'ielts',
  );

  // 重新扫描本页；顺带把语境义打开，验证「通没通」真的会被说出来
  state.settings.sense.enabled = true;
  $('btn-rescan').dispatchEvent(new dom.window.Event('click'));
  await sleep(30);
  check(
    '重新扫描会通知 content script',
    tabRequestsOf(state, 'wordmark:apply-settings').length === 1,
    JSON.stringify(tabRequestsOf(state, 'wordmark:apply-settings')),
  );
  check(
    '重新扫描后会重新拉取本页统计',
    tabRequestsOf(state, 'wordmark:page-stats').length === 2,
    String(tabRequestsOf(state, 'wordmark:page-stats').length),
  );
  check(
    '语境义生效时会说出替换了多少处',
    $('sense-state')?.textContent === '语境义：服务已连通，本页替换 5 处',
    $('sense-state')?.textContent,
  );

  $('btn-options').dispatchEvent(new dom.window.Event('click'));
  await sleep(20);
  check('点「设置」会打开设置页', state.optionsOpened);

  check('全程没有未捕获异常', state.errors.length === 0, state.errors.slice(0, 3).join(' | '));
  dom.window.close();
  report('弹窗冒烟测试');
}

async function main() {
  const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
  const version = manifest.version;

  await checkOptions(version);
  await checkPopup(version);
}

await main();
