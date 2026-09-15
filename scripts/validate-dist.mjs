/**
 * 构建产物校验。
 *
 * 单元测试覆盖的是源码逻辑，这个脚本覆盖的是「可安装性」：
 * manifest 是否自洽、引用的文件是否都在、有没有引入 MV3 禁止的
 * 动态代码（eval / new Function），以及词表是否真的打进了包里。
 *
 * 用法：npm run build && npm run validate
 */

import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

async function exists(relative) {
  try {
    await stat(path.join(DIST, relative));
    return true;
  } catch {
    return false;
  }
}

async function read(relative) {
  return readFile(path.join(DIST, relative), 'utf8');
}

async function requireFile(relative, why) {
  if (!(await exists(relative))) fail(`缺少 ${relative}（${why}）`);
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

  if (!(await exists('manifest.json'))) {
    fail('缺少 dist/manifest.json，请先运行 npm run build:prod');
    report();
    return;
  }

  const manifest = JSON.parse(await read('manifest.json'));

  // --- manifest 基本约束 ---
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
  if (manifest.version !== pkg.version) {
    fail(`manifest.version (${manifest.version}) 与 package.json (${pkg.version}) 不一致`);
  }
  for (const key of ['name', 'description', 'version']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      fail(`manifest.${key} 不能为空`);
    }
  }

  // --- 引用的文件都要存在 ---
  for (const [size, file] of Object.entries(manifest.icons ?? {})) {
    await requireFile(file, `icons.${size}`);
  }
  for (const [size, file] of Object.entries(manifest.action?.default_icon ?? {})) {
    await requireFile(file, `action.default_icon.${size}`);
  }
  await requireFile(manifest.action?.default_popup ?? '', 'action.default_popup');
  await requireFile(manifest.options_ui?.page ?? '', 'options_ui.page');
  await requireFile(manifest.background?.service_worker ?? '', 'background.service_worker');

  const contentScripts = manifest.content_scripts ?? [];
  if (contentScripts.length === 0) fail('没有声明 content_scripts');
  for (const entry of contentScripts) {
    for (const file of [...(entry.js ?? []), ...(entry.css ?? [])]) {
      await requireFile(file, 'content_scripts');
    }
    if (!Array.isArray(entry.matches) || entry.matches.length === 0) {
      fail('content_scripts.matches 不能为空');
    }
  }

  if (manifest.background?.type !== 'module') {
    fail('service worker 建议声明 "type": "module"');
  }
  if (!manifest.permissions?.includes('storage')) {
    fail('缺少 storage 权限（设置与已知词表需要）');
  }

  // 弹窗曾经直接读 `tab.url` 来判断当前站点：Chrome 只在扩展拥有该标签页的
  // host 权限时才暴露 url（content_scripts.matches 不算），真浏览器实测弹窗
  // 拿到的永远是空串，于是任何站点都显示「不支持」。现在改成问内容脚本要
  // host；这条守卫用来防止有人再退回读 tab.url。
  if (await exists('popup.js')) {
    const popup = await read('popup.js');
    const readsTabUrl = /tabs\.query/.test(popup) && /\.url\b/.test(popup);
    const canSeeTabUrl =
      manifest.permissions?.includes('tabs') ||
      manifest.permissions?.includes('activeTab') ||
      (manifest.host_permissions ?? []).some((pattern) => /<all_urls>|\*:\/\/\*/.test(pattern));
    if (readsTabUrl && !canSeeTabUrl) {
      fail('popup.js 读取 tab.url，但 manifest 里没有 tabs / activeTab 权限（弹窗会拿不到当前站点）');
    }
  }
  if (await exists('content.js')) {
    const content = await read('content.js');
    if (!/wordmark:page-stats/.test(content)) {
      fail('content.js 没有响应 wordmark:page-stats，弹窗将拿不到站点与统计');
    }
  }

  // --- 扩展页面引用的脚本 / 样式 ---
  for (const page of [manifest.action?.default_popup, manifest.options_ui?.page]) {
    if (typeof page !== 'string') continue;
    if (!(await exists(page))) continue;
    const html = await read(page);
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((ref) => !/^(https?:)?\/\//.test(ref));
    for (const ref of refs) {
      await requireFile(ref.replace(/^\.\//, ''), `${page} 引用`);
    }
    if (/<script[^>]*>[^<]/.test(html)) {
      fail(`${page} 含内联脚本，会被 MV3 CSP 拦截`);
    }
  }

  // --- MV3 禁止的动态代码 ---
  const bundles = ['content.js', 'background.js', 'popup.js', 'options.js'];
  for (const bundle of bundles) {
    if (!(await exists(bundle))) {
      fail(`缺少 ${bundle}`);
      continue;
    }
    const code = await read(bundle);
    if (/\beval\s*\(/.test(code)) fail(`${bundle} 含 eval(，MV3 不允许`);
    if (/new\s+Function\s*\(/.test(code)) fail(`${bundle} 含 new Function，MV3 不允许`);
    if (/\bhttp:\/\//.test(code)) {
      const snippet = code.match(/.{0,40}http:\/\/.{0,40}/)?.[0] ?? '';
      notes.push(`${bundle} 出现明文 http:// —— 确认是否必要：…${snippet.trim()}…`);
    }
  }

  // --- 词表确实打进了 content script ---
  if (await exists('content.js')) {
    const content = await read('content.js');
    if (!content.includes('转瞬即逝的')) {
      fail('content.js 里找不到内置词表内容（npm run dict 是否执行过？）');
    }
    if (!/wordmark-gloss/.test(content)) fail('content.js 缺少标注相关代码');
  }

  // --- 体积参考 ---
  for (const bundle of bundles) {
    if (!(await exists(bundle))) continue;
    const { size } = await stat(path.join(DIST, bundle));
    notes.push(`${bundle} ${(size / 1024).toFixed(1)}KB`);
  }

  report();
}

function report() {
  for (const note of notes) console.log(`  · ${note}`);
  if (problems.length > 0) {
    console.error(`✗ 构建校验失败（${problems.length} 项）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('✓ 构建校验通过：manifest 自洽、资源齐全、无动态代码');
}

await main();
