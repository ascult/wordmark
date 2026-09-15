/**
 * 构建脚本：esbuild 打包 + 资源拷贝 + manifest 版本注入。
 *
 * 产物结构（dist/）：
 *   manifest.json  background.js  content.js  content.css
 *   popup.html popup.js popup.css  options.html options.js options.css  icons/
 *
 * 用法：
 *   node scripts/build.mjs            一次性构建（含 sourcemap）
 *   node scripts/build.mjs --watch    监听重建
 *   node scripts/build.mjs --minify    生产构建（无 sourcemap、压缩）
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');

const flags = new Set(process.argv.slice(2));
const watch = flags.has('--watch');
const minify = flags.has('--minify') && !watch;

/** 每个入口的打包方式：content/popup/options 是 IIFE，background 是 ESM。 */
const ENTRIES = [
  { in: path.join(SRC, 'content', 'index.ts'), out: 'content', format: 'iife' },
  { in: path.join(SRC, 'background', 'index.ts'), out: 'background', format: 'esm' },
  { in: path.join(SRC, 'popup', 'popup.ts'), out: 'popup', format: 'iife' },
  { in: path.join(SRC, 'options', 'options.ts'), out: 'options', format: 'iife' },
];

const STATIC_FILES = [
  [path.join(SRC, 'popup', 'popup.html'), 'popup.html'],
  [path.join(SRC, 'popup', 'popup.css'), 'popup.css'],
  [path.join(SRC, 'options', 'options.html'), 'options.html'],
  [path.join(SRC, 'options', 'options.css'), 'options.css'],
  [path.join(SRC, 'content', 'styles.css'), 'content.css'],
];

async function buildManifest() {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8'));
  // 版本号只维护在 package.json，避免两处不一致。
  manifest.version = pkg.version;
  await writeFile(path.join(DIST, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function copyStatic() {
  for (const [from, to] of STATIC_FILES) {
    await cp(from, path.join(DIST, to));
  }
  await cp(path.join(SRC, 'public', 'icons'), path.join(DIST, 'icons'), { recursive: true });
}

function buildOptions(entry) {
  return {
    entryPoints: [entry.in],
    outfile: path.join(DIST, `${entry.out}.js`),
    bundle: true,
    format: entry.format,
    // Chrome 114+ 对 ES2022 支持完整；不向下兼容是为了产物更小。
    target: ['chrome114'],
    platform: 'browser',
    charset: 'utf8',
    legalComments: 'none',
    minify,
    sourcemap: minify ? false : 'linked',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify(minify ? 'production' : 'development') },
  };
}

async function buildOnce() {
  await mkdir(DIST, { recursive: true });
  await copyStatic();
  const manifest = await buildManifest();
  await Promise.all(ENTRIES.map((entry) => esbuild.build(buildOptions(entry))));
  const sizes = await Promise.all(
    ENTRIES.map(async (entry) => {
      const file = path.join(DIST, `${entry.out}.js`);
      const stat = await readFile(file);
      return `${entry.out}.js ${(stat.byteLength / 1024).toFixed(1)}KB`;
    }),
  );
  console.log(`✓ 构建完成 → dist/  v${manifest.version}${minify ? ' (minified)' : ''}`);
  console.log(`  ${sizes.join('  ')}`);
}

async function main() {
  if (!watch) {
    await rm(DIST, { recursive: true, force: true });
    await buildOnce();
    return;
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });
  await copyStatic();
  await buildManifest();

  const contexts = await Promise.all(
    ENTRIES.map((entry) => esbuild.context(buildOptions(entry))),
  );
  await Promise.all(contexts.map((context) => context.watch()));
  // 静态资源与 manifest 没有 watcher：改动后重跑一次构建即可。
  console.log('✓ 监听中（src/**）… 修改 HTML/CSS 需重新运行 npm run dev');

  const manifest = JSON.parse(await readFile(path.join(SRC, 'manifest.json'), 'utf8'));
  console.log(`  产物：dist/manifest.json（v${manifest.version}）`);
}

await main();
