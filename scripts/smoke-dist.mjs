/**
 * 端到端冒烟测试：把「构建产物」加载进 jsdom，验证真实可安装的
 * 那份代码能完成一次标注，而不只是源码单测能过。
 *
 * 覆盖点：
 * - content.js 能独立启动（无 chrome.* 时优雅降级到内存存储）
 * - 内置词表命中并插入释义
 * - 代码块不被改动
 * - MutationObserver 让动态追加的内容也被标注
 * - 每页只标注第一次的默认策略生效
 *
 * 用法：npm run build:prod && npm run smoke
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label}${detail === '' ? '' : ` —— ${detail}`}`);
  console.log(`  ✗ ${label}${detail === '' ? '' : ` —— ${detail}`}`);
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

async function main() {
  const code = await readFile(path.join(DIST, 'content.js'), 'utf8');

  const html = `<!doctype html><html><body>
    <article>
      <p>Field notes show ephemeral patterns across biodiversity hotspots.</p>
      <pre><code>ephemeral biodiversity plethora</code></pre>
    </article>
  </body></html>`;

  // url 决定 location.hostname（用于站点规则判断）
  const dom = new JSDOM(html, {
    url: 'https://example.com/notes',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  // 没有 chrome.* 全局：content script 会走内存存储与本地词表
  dom.window.eval(code);

  const { document } = dom.window;
  const marks = () => [...document.querySelectorAll('[data-wordmark-lemma]')];
  const markFor = (lemma) =>
    marks().find((node) => node.getAttribute('data-wordmark-lemma') === lemma);

  console.log('端到端冒烟测试（加载 dist/content.js）');

  const glossed = await waitFor(() => markFor('ephemeral') && markFor('biodiversity'));
  check('内置词表命中并插入释义', glossed, `实际标注 ${marks().length} 处`);

  const ephemeral = markFor('ephemeral');
  check(
    '释义内容与词表一致',
    ephemeral?.textContent?.includes('转瞬即逝的') ?? false,
    `实际 "${ephemeral?.textContent ?? ''}"`,
  );
  check(
    '原始英文词保留在正文里',
    document.body.textContent.includes('ephemeral（转瞬即逝的）'),
    document.body.textContent.slice(0, 120),
  );
  check('根节点挂上启用标记', document.documentElement.classList.contains('wordmark-active'));
  check(
    '代码块内的文字未被标注',
    document.querySelector('code')?.textContent.trim() === 'ephemeral biodiversity plethora' &&
      document.querySelector('code')?.querySelector('[data-wordmark]') === null,
  );

  // 动态内容：MutationObserver 应该在去抖后把新段落也标注上
  const paragraph = document.createElement('p');
  paragraph.textContent = 'A plethora of ephemeral signals appeared.';
  document.body.appendChild(paragraph);

  const dynamic = await waitFor(() => markFor('plethora'));
  check('动态追加的内容也会被标注', dynamic);
  check(
    '每页只标注第一次（ephemeral 仍只有一处）',
    marks().filter((node) => node.getAttribute('data-wordmark-lemma') === 'ephemeral').length === 1,
    `实际 ${marks().filter((n) => n.getAttribute('data-wordmark-lemma') === 'ephemeral').length} 处`,
  );

  if (failures.length > 0) {
    console.error(`\n✗ 冒烟测试失败（${failures.length} 项）`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`\n✓ 冒烟测试通过：真实产物完成 ${marks().length} 处标注`);
}

await main();
