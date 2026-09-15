/**
 * 打包成可直接上传 Chrome 应用商店的 zip。
 *
 * Chrome 要求 manifest.json 位于压缩包根目录，所以打包的是
 * dist/ 的内容而不是 dist/ 本身。
 */

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const target = path.join(ROOT, `wordmark-v${pkg.version}.zip`);

const result = spawnSync('zip', ['-r', '-q', target, '.', '-x', '*.map'], {
  cwd: DIST,
  stdio: 'inherit',
});

if (result.error) {
  console.error('✗ 找不到 zip 命令，请先执行 npm run build:prod 后手动压缩 dist/ 目录');
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`✗ zip 退出码 ${result.status}`);
  process.exit(result.status ?? 1);
}
console.log(`✓ 已打包 → ${path.relative(ROOT, target)}`);
