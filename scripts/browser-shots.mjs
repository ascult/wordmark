/**
 * 真浏览器验证：用 CDP 驱动本地 Chromium 加载扩展，截图并做功能断言。
 *
 * 为什么不用 puppeteer / playwright：本项目不需要多一个依赖——Node 24 自带
 * `fetch` 与 `WebSocket`，而 CDP 本身就是 WebSocket + JSON，直接说协议更可控，
 * 也能精确控制「加载已解压扩展」这类只有真浏览器才有的行为。
 *
 * 拿到的是 jsdom 给不了的三件事：
 *   1. 真实排版下的视觉效果（字号、换行、颜色、与页面样式的相互作用）；
 *   2. 真实的 MV3 运行时（service worker、chrome.storage、消息往返）；
 *   3. 真实点击（Input.dispatchMouseEvent 打在元素坐标上，走完整事件链）。
 *
 * 用法：
 *   node scripts/browser-shots.mjs [--article=<缓存的 html 文件名>] [--keep-open]
 *
 * 产物：.tmp-shots/*.png，以及 stdout 上的断言结果。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(ROOT, '.tmp-articles');
const SHOT_DIR = path.join(ROOT, '.tmp-shots');
const PROFILE_DIR = path.join(ROOT, '.tmp-chrome', 'profile');
const DEBUG_PORT = 9333;

const CHROMIUM_CANDIDATES = [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

const args = process.argv.slice(2);
const keepOpen = args.includes('--keep-open');
const articleFlag = args.find((arg) => arg.startsWith('--article='));
const ARTICLE_FILE = articleFlag ? articleFlag.split('=')[1] : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` —— ${detail}`}`);
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                      */
/* ------------------------------------------------------------------ */

class Cdp {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = [];

  static async connect(wsUrl, { timeoutMs = 15_000 } = {}) {
    const client = new Cdp();
    const ws = new WebSocket(wsUrl);
    client.#ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP 连接失败：${event.message ?? 'unknown'}`));
      });
    });
    ws.addEventListener('message', (event) => client.#onMessage(event.data));
    return client;
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const { resolve, reject } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}（${message.error.code}）`));
      else resolve(message.result);
      return;
    }
    if (message.method) {
      for (const listener of this.#listeners) listener(message.method, message.params);
    }
  }

  onEvent(listener) {
    this.#listeners.push(listener);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP 超时：${method}`));
      }, 30_000);
    });
  }

  /** 在页面里求值；返回可序列化结果。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`页面求值异常：${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  /** 轮询直到表达式为真。 */
  async waitFor(expression, { timeoutMs = 15_000, intervalMs = 150, label = expression } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return true;
      await sleep(intervalMs);
    }
    throw new Error(`等待超时：${label}`);
  }

  async screenshot(file, { clip, fullPage = false } = {}) {
    const params = { format: 'png' };
    if (clip) {
      // CDP 的 clip 用「页面坐标」，而 getBoundingClientRect 给的是视口坐标，
      // 少这层换算就会截到文档顶部的空白（曾经截出一张全白图）。
      params.clip = {
        x: clip.x + (clip.scrollX ?? 0),
        y: clip.y + (clip.scrollY ?? 0),
        width: clip.width,
        height: clip.height,
        scale: clip.scale ?? 1,
      };
      params.captureBeyondViewport = true;
    } else if (fullPage) {
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    await writeFile(path.join(SHOT_DIR, file), Buffer.from(data, 'base64'));
    return file;
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // 忽略：浏览器可能已经退出
    }
  }
}

/* ------------------------------------------------------------------ */
/* 浏览器与静态服务器                                                   */
/* ------------------------------------------------------------------ */

function findChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chromium/Chrome 可执行文件');
}

async function launchBrowser() {
  const binary = findChromium();
  await rm(PROFILE_DIR, { recursive: true, force: true });
  await mkdir(PROFILE_DIR, { recursive: true });

  const child = spawn(
    binary,
    [
      // --no-sandbox 是这台机器的必需项：Chromium 自身的沙箱在此环境里
      // 初始化会被拒（sandbox initialization failed），随后 GPU 进程直接崩。
      '--no-sandbox',
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  );
  child.unref();

  // 等调试端口就绪
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) {
        const version = await response.json();
        return { child, version };
      }
    } catch {
      // 还没起来
    }
    await sleep(300);
  }
  throw new Error('Chromium 调试端口未就绪');
}

async function listTargets() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return response.json();
}

/**
 * 浏览器级 CDP：只有它才能做目标管理（新建 / 激活 / 关闭窗口里的标签）。
 * 页面级会话发不了 Target.* 域的命令。
 */
async function connectBrowser() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const { webSocketDebuggerUrl } = await response.json();
  return Cdp.connect(webSocketDebuggerUrl);
}

/** 新建页面目标并连上它的 CDP。 */
async function openPage(browser, url, { newWindow = false } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow });
  const deadline = Date.now() + 10_000;
  let wsUrl = null;
  while (Date.now() < deadline && wsUrl === null) {
    const targets = await listTargets();
    wsUrl = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl ?? null;
    if (wsUrl === null) await sleep(100);
  }
  if (wsUrl === null) throw new Error(`拿不到目标调试地址：${targetId}`);
  const cdp = await Cdp.connect(wsUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, targetId };
}

async function closeTarget(browser, targetId) {
  try {
    await browser.send('Target.closeTarget', { targetId });
  } catch {
    // 忽略
  }
}

function startStaticServer() {
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8' };
  const server = createServer(async (request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/+/, '');
    if (name === '' || name === 'index') {
      const files = (await readdir(CACHE_DIR)).filter((file) => file.endsWith('.html'));
      response.writeHead(200, { 'content-type': types['.html'] });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>wordmark 测试文章</title><ul>${files
          .map((file) => `<li><a href="/${file}">${file}</a></li>`)
          .join('')}</ul>`,
      );
      return;
    }
    try {
      const body = await readFile(path.join(CACHE_DIR, path.basename(name)));
      response.writeHead(200, { 'content-type': types[path.extname(name)] ?? 'text/plain' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* 断言与截图                                                          */
/* ------------------------------------------------------------------ */

const GLOSS_COUNT = `document.querySelectorAll('[data-wordmark-lemma]').length`;

/** 等标注数量稳定下来（重扫先清空再分批重建，中途的数字没有意义）。 */
async function settleGlossCount(cdp, { timeoutMs = 25_000, rounds = 4 } = {}) {
  let current = -1;
  let stable = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await cdp.evaluate(GLOSS_COUNT);
    if (count === current && count > 0) {
      stable += 1;
      if (stable >= rounds) return count;
    } else {
      stable = 0;
    }
    current = count;
    await sleep(250);
  }
  return current;
}

async function shootArticle(cdp, url, consoleErrors) {
  console.log('\n[1] 真实文章：默认配置');
  await cdp.setViewport(1280, 900, 2);
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor(`document.readyState === 'complete'`, { label: '页面加载完成' });

  await cdp.waitFor(`${GLOSS_COUNT} > 0`, { label: '出现第一个释义' });
  await sleep(1200); // 等这一页的批次跑完

  const stats = await cdp.evaluate(`(() => {
    const marks = [...document.querySelectorAll('[data-wordmark-lemma]')];
    const lemmas = [...new Set(marks.map((m) => m.getAttribute('data-wordmark-lemma')))];
    const first = marks.find((m) => m.textContent.length > 0);
    const style = first ? getComputedStyle(first.querySelector('.wordmark-def')) : null;
    return {
      marks: marks.length,
      lemmas: lemmas.length,
      sample: lemmas.slice(0, 12),
      firstText: first ? first.textContent : null,
      defColor: style ? style.color : null,
      defFontSize: style ? style.fontSize : null,
      parentFontSize: first ? getComputedStyle(first).fontSize : null,
      userSelect: style ? style.userSelect || style.webkitUserSelect : null,
      rootClass: document.documentElement.className,
      bodyText: document.body.textContent.length,
    };
  })()`);

  check('真实浏览器里插入了释义', stats.marks > 0, `${stats.marks} 处 / ${stats.lemmas} 个词元`);
  check('释义是中文', /[\u4e00-\u9fff]/.test(stats.firstText ?? ''), stats.firstText ?? '');
  check('释义字号小于正文', parseFloat(stats.defFontSize) < parseFloat(stats.parentFontSize),
    `释义 ${stats.defFontSize} < 正文 ${stats.parentFontSize}`);
  check('释义不可被选中复制（user-select）', stats.userSelect === 'none', String(stats.userSelect));
  check('根节点挂上启用标记', String(stats.rootClass).includes('wordmark-active'), stats.rootClass);
  console.log(`     样例：${stats.sample.join(', ')}`);

  await cdp.evaluate('window.scrollTo(0, 0)');
  await sleep(300);
  await cdp.screenshot('01-article-viewport.png');

  // 找到第一段带释义的正文，裁一张特写
  const box = await cdp.evaluate(`(() => {
    const mark = document.querySelector('[data-wordmark-lemma]');
    const block = mark.closest('p, li, td, div') ?? mark.parentElement;
    block.scrollIntoView({ block: 'center' });
    const r = block.getBoundingClientRect();
    return { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: Math.min(Math.max(r.width + 16, 320), 1100), height: Math.min(Math.max(r.height + 16, 60), 420), scrollX: window.scrollX, scrollY: window.scrollY, text: (block.textContent || '').trim().slice(0, 60) };
  })()`);
  await sleep(300);
  await cdp.screenshot('02-article-detail.png', { clip: { ...box, scale: 2 } });
  check('特写区域落在有释义的段落上', box.width >= 320 && box.text.length > 0, box.text);

  // 用真实点击验证「点中文 = 标记已知词」
  const clickInfo = await cdp.evaluate(`(() => {
    const def = document.querySelector('.wordmark-def');
    const wrapper = def.closest('.wordmark-gloss');
    const lemma = wrapper.getAttribute('data-wordmark-lemma');
    def.scrollIntoView({ block: 'center' });
    const r = def.getBoundingClientRect();
    return { lemma, x: r.x + r.width / 2, y: r.y + r.height / 2, before: document.querySelectorAll('[data-wordmark-lemma="' + lemma + '"]').length };
  })()`);
  await sleep(300);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clickInfo.x, y: clickInfo.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickInfo.x, y: clickInfo.y, button: 'left', clickCount: 1 });
  await sleep(600);

  const afterClick = await cdp.evaluate(`(() => ({
    remaining: document.querySelectorAll('[data-wordmark-lemma="${clickInfo.lemma}"]').length,
    toast: document.querySelector('.wordmark-toast')?.textContent ?? null,
    known: null,
  }))()`);
  check('真实点击中文释义后移除该词释义', afterClick.remaining < clickInfo.before,
    `${clickInfo.lemma}: ${clickInfo.before} → ${afterClick.remaining}`);
  check('弹出「已标记为已知词」提示', (afterClick.toast ?? '').includes('已知词'), afterClick.toast ?? '无 toast');

  await cdp.screenshot('03-article-after-click.png');
  return { ...stats, clicked: clickInfo.lemma, consoleErrors };
}

async function shootExtensionPage(cdp, url, { width, height, file, ready, label, navigate = true }) {
  await cdp.setViewport(width, height, 2);
  if (navigate) {
    await cdp.send('Page.navigate', { url });
  }
  await cdp.waitFor(`document.readyState === 'complete'`, { label: `${label} 加载完成` });
  if (ready) await cdp.waitFor(ready, { label: `${label} 渲染完成` });
  await sleep(400);
  const info = await cdp.evaluate(`(() => ({
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220),
    height: document.documentElement.scrollHeight,
  }))()`);
  await cdp.screenshot(file, { fullPage: true });
  return info;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  if (!existsSync(path.join(DIST, 'manifest.json'))) {
    throw new Error('缺少 dist/manifest.json，先跑 npm run build:prod');
  }
  await mkdir(SHOT_DIR, { recursive: true });
  if (!existsSync(CACHE_DIR)) {
    throw new Error('没有缓存的文章，先跑一次 npm run bench');
  }

  const cached = (await readdir(CACHE_DIR)).filter((file) => file.endsWith('.html'));
  const articleFile = ARTICLE_FILE ?? cached.find((file) => file.includes('paulgraham')) ?? cached[0];
  if (!articleFile) throw new Error('缓存目录里没有 html');

  const { server, port } = await startStaticServer();
  const articleUrl = `http://127.0.0.1:${port}/${articleFile}`;
  console.log(`静态服务器 http://127.0.0.1:${port} → 文章：${articleFile}`);

  const { child, version } = await launchBrowser();
  console.log(`浏览器：${version.Browser}（headless）`);

  const consoleErrors = [];

  try {
    // 扩展 ID 从 service worker 目标里拿——这是 MV3 运行时才有的信息
    const deadline = Date.now() + 20_000;
    let extensionId = null;
    while (Date.now() < deadline && extensionId === null) {
      const targets = await listTargets();
      const worker = targets.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
      if (worker) extensionId = new URL(worker.url).host;
      else await sleep(300);
    }
    check('MV3 service worker 已注册', extensionId !== null, extensionId ?? '未找到');
    if (extensionId === null) throw new Error('扩展没有加载，后续验证无法进行');

    // 文章页
    const browser = await connectBrowser();
    const article = await openPage(browser, 'about:blank');
    const { cdp, targetId } = article;
    cdp.onEvent((method, params) => {
      if (method === 'Runtime.exceptionThrown') {
        consoleErrors.push(params.exceptionDetails?.text ?? 'unknown');
      }
      if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description).join(' '));
      }
    });
    const articleStats = await shootArticle(cdp, articleUrl, consoleErrors);

    // 弹窗：真实弹窗不是标签页，它读的是「当前窗口的活动标签」。
    // 所以这里把 popup 建在同一个窗口里，再把文章页激活，然后 reload 让
    // popup 的 main() 在「文章页是活动标签」的状态下重新跑一遍。
    console.log('\n[2] 扩展弹窗 popup.html');
    const popup = await openPage(browser, 'about:blank');
    await browser.send('Target.activateTarget', { targetId });
    await popup.cdp.send('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` });
    await popup.cdp.waitFor(`document.readyState === 'complete'`, { label: '弹窗加载完成' });
    await popup.cdp.send('Page.reload');
    await sleep(500);
    const popupDiag = await popup.cdp.evaluate(`(async () => {
      const active = await chrome.tabs.query({ active: true, currentWindow: true });
      const all = await chrome.tabs.query({});
      return {
        active: active.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 56) })),
        all: all.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 56) })),
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160),
      };
    })()`);
    console.log(`     弹窗自检：活动标签 ${JSON.stringify(popupDiag.active)}`);
    console.log(`     弹窗自检：窗口内标签 ${JSON.stringify(popupDiag.all)}`);
    await popup.cdp.waitFor(`document.querySelector('#stat-glossed')?.textContent !== '–'`, {
      label: `弹窗读到本页统计（当前显示：${popupDiag.text}）`,
      timeoutMs: 10_000,
    });
    const popupInfo = await shootExtensionPage(popup.cdp, `chrome-extension://${extensionId}/popup.html`, {
      width: 360,
      height: 520,
      file: '04-popup.png',
      ready: `document.querySelector('#stat-glossed')?.textContent !== '–'`,
      label: '弹窗',
      navigate: false,
    });

    const popupState = await popup.cdp.evaluate(`(() => ({
      host: document.getElementById('site-host').textContent,
      glossed: document.getElementById('stat-glossed').textContent,
      unique: document.getElementById('stat-unique').textContent,
      global: document.getElementById('toggle-global').checked,
      site: document.getElementById('toggle-site').checked,
      siteDisabled: document.getElementById('toggle-site').disabled,
      level: document.getElementById('select-level').value,
    }))()`);
    check('弹窗显示当前站点', popupState.host === '127.0.0.1', popupState.host);
    check('弹窗从 content script 读到真实统计', Number(popupState.glossed) > 300,
      `${popupState.glossed} 处 / ${popupState.unique} 个词元`);
    check('弹窗开关回填正确', popupState.global === true && popupState.site === true && popupState.siteDisabled === false,
      `总开关 ${popupState.global} / 本站 ${popupState.site}`);

    // 弹窗操作：把生词线切到 CET-6，再回读
    await popup.cdp.evaluate(`(() => {
      const select = document.getElementById('select-level');
      select.value = 'cet6';
      select.dispatchEvent(new Event('change'));
    })()`);
    await sleep(600);
    const afterSwitch = await popup.cdp.evaluate(`document.getElementById('select-level').value`);
    check('弹窗能切换生词线并写回设置', afterSwitch === 'cet6', afterSwitch);
    await popup.cdp.screenshot('05-popup-after-switch.png');

    // 设置变更应该通过 storage 传到文章页：重扫后只剩下更高难度的词。
    // 必须等重扫跑完——它先清空再分批重建，中途读到的数字没有意义。
    const hot = await settleGlossCount(cdp);
    const hotDiag = await cdp.evaluate(`(() => {
      const marks = [...document.querySelectorAll('[data-wordmark-lemma]')];
      const blocks = new Set(marks.map((m) => m.closest('p, li, h1, h2, h3, td') ?? m.parentElement));
      return {
        blocksWithGloss: blocks.size,
        totalBlocks: document.querySelectorAll('p, li, h1, h2, h3, td').length,
        samples: marks.slice(0, 10).map((m) => {
          const b = m.closest('p, li, h1, h2, h3, td') ?? m.parentElement;
          return (b.textContent || '').trim().slice(0, 28);
        }),
        visibility: document.visibilityState,
        idle: typeof requestIdleCallback,
        bodyText: document.body.textContent.length,
      };
    })()`);
    console.log(
      `     热重扫分布：${hotDiag.blocksWithGloss}/${hotDiag.totalBlocks} 个块有释义；visibility=${hotDiag.visibility}；rIC=${hotDiag.idle}；正文 ${hotDiag.bodyText} 字符`,
    );
    console.log(`     落在这些段落：${JSON.stringify(hotDiag.samples)}`);
    // 再强制重扫一次：重扫必须是幂等的，不能逐次衰减
    await popup.cdp.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tabs[0].id, { type: 'wordmark:apply-settings' });
    })()`);
    const rescanned = await settleGlossCount(cdp);
    check('反复重扫不会让标注逐次衰减', Math.abs(rescanned - hot) <= 2,
      `第一次 ${hot} 处 → 再扫一次 ${rescanned} 处`);

    // yield 机制体检：分批扫描靠它让出主线程，如果它不回调，扫描就会卡死
    const yieldProbe = await cdp.evaluate(`(async () => {
      const probe = (register) => new Promise((resolve) => {
        const t0 = performance.now();
        const timer = setTimeout(() => resolve({ fired: false, ms: Math.round(performance.now() - t0) }), 3000);
        register(() => { clearTimeout(timer); resolve({ fired: true, ms: Math.round(performance.now() - t0) }); });
      });
      return {
        idle: await probe((done) => requestIdleCallback(done, { timeout: 200 })),
        timeout0: await probe((done) => setTimeout(done, 0)),
        schedulerYield: typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function' ? 'yes' : 'no',
      };
    })()`);
    console.log(
      `     yield 体检：requestIdleCallback ${yieldProbe.idle.fired ? `${yieldProbe.idle.ms}ms 内回调` : '3 秒内从未回调'}；setTimeout(0) ${yieldProbe.timeout0.ms}ms；scheduler.yield=${yieldProbe.schedulerYield}`,
    );
    check('设置变更实时同步到已打开的页面', hot > 0 && hot < articleStats.marks,
      `热重扫：${articleStats.marks} → ${hot} 处`);
    await cdp.screenshot('05b-article-cet6.png');

    // 冷启动对照：同样的设置重新加载一次页面。两条路径的结果必须一致，
    // 否则说明「热重扫」漏标了——只有真浏览器能发现这类增量状态问题。
    await cdp.send('Page.reload');
    await cdp.waitFor(`document.readyState === 'complete'`, { label: '重新加载' });
    await cdp.waitFor(`${GLOSS_COUNT} > 0`, { label: '重载后出现释义' });
    const cold = await settleGlossCount(cdp);
    check('热重扫与冷启动结果一致', Math.abs(cold - hot) <= 2, `热重扫 ${hot} 处 vs 冷启动 ${cold} 处`);

    await closeTarget(browser, popup.targetId);

    // 设置页
    console.log('\n[3] 设置页 options.html');
    const options = await openPage(browser, 'about:blank');
    const optionsInfo = await shootExtensionPage(options.cdp, `chrome-extension://${extensionId}/options.html`, {
      width: 920,
      height: 1400,
      file: '06-options.png',
      ready: `document.getElementById('dict-total')?.textContent !== '–'`,
      label: '设置页',
    });
    const dictStats = await options.cdp.evaluate(`(() => ({
      total: document.getElementById('dict-total').textContent,
      basic: document.getElementById('dict-basic').textContent,
      cet4: document.getElementById('dict-cet4').textContent,
      gre: document.getElementById('dict-gre').textContent,
      level: document.getElementById('annotateFrom').value,
    }))()`);
    check('设置页渲染五档词表统计', Number(dictStats.total) === 3039 && Number(dictStats.basic) === 434,
      `总 ${dictStats.total} / 基础 ${dictStats.basic} / CET-4 ${dictStats.cet4} / GRE ${dictStats.gre}`);
    check('设置页回填弹窗改过的生词线', dictStats.level === 'cet6', dictStats.level);
    await closeTarget(browser, options.targetId);
    await closeTarget(browser, targetId);
    browser.close();

    check('整轮没有页面级 JS 异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

    console.log(`\n文章标注 ${articleStats.marks} 处；弹窗读到「${(popupInfo.text || '').slice(0, 40)}…」`);
    console.log(`设置页读到「${(optionsInfo.text || '').slice(0, 40)}…」`);
  } finally {
    if (!keepOpen) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略
        }
      }
      server.close();
    }
  }

  const failed = results.filter((item) => !item.ok);

  // 挑三张有代表性的图作为文档配图（README 会引用），其余留在 .tmp-shots/
  if (failed.length === 0) {
    const docsDir = path.join(ROOT, 'docs', 'screenshots');
    await mkdir(docsDir, { recursive: true });
    const publish = [
      ['02-article-detail.png', 'article-glosses.png'],
      ['04-popup.png', 'popup.png'],
      ['06-options.png', 'options.png'],
    ];
    for (const [from, to] of publish) {
      try {
        await cp(path.join(SHOT_DIR, from), path.join(docsDir, to));
      } catch {
        // 图没生成就算了，不影响验证结论
      }
    }
    console.log(`\n文档配图已更新：${path.relative(ROOT, docsDir)}/`);
  }

  console.log(`\n截图目录：${path.relative(ROOT, SHOT_DIR)}`);
  if (failed.length > 0) {
    console.error(`\n✗ 真浏览器验证失败 ${failed.length} 项`);
    for (const item of failed) console.error(`  - ${item.label}${item.detail === '' ? '' : ` —— ${item.detail}`}`);
    process.exit(1);
  }
  console.log(`\n✓ 真浏览器验证通过：${results.length} 项断言，截图已保存`);
}

await main();
