/**
 * 真实文章基准测试。
 *
 * 拿一组固定的真实文章跑 dist/content.js，输出一张对照表；配合
 * --save / --compare 就能量化「改了词表或算法之后，真实覆盖率变了多少」。
 *
 * 用法：
 *   node scripts/article-bench.mjs                     # 跑一遍并打印表格
 *   node scripts/article-bench.mjs --save=before.json  # 存档
 *   node scripts/article-bench.mjs --compare=before.json  # 与存档对比
 *
 * 注意：抓下来的 HTML 会缓存在 .tmp-articles/，因此对比时用的是同一份页面。
 */

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 覆盖面刻意做杂：长文随笔、技术博客、科普长文、杂志首页、19 世纪小说。 */
const ARTICLES = [
  'https://paulgraham.com/greatwork.html',
  'https://blog.samaltman.com/how-to-be-successful',
  'https://danluu.com/why-benchmark/',
  'https://waitbutwhy.com/2015/01/artificial-intelligence-revolution-1.html',
  'https://www.smithsonianmag.com/',
  'https://www.gutenberg.org/cache/epub/1342/pg1342-images.html',
];

const args = process.argv.slice(2);
const saveFlag = args.find((arg) => arg.startsWith('--save='));
const compareFlag = args.find((arg) => arg.startsWith('--compare='));
const levelsMode = args.includes('--levels');
const repeatFlag = args.find((arg) => arg.startsWith('--repeat='));
const REPEAT = repeatFlag ? repeatFlag.split('=')[1] : null;

/** 生词线由易到难；--levels 会逐个跑一遍，得到「密度曲线」。 */
const LEVELS = ['basic', 'cet4', 'cet6', 'ielts', 'gre'];
const LEVEL_LABELS = {
  basic: '基础词及以上',
  cet4: 'CET-4 及以上',
  cet6: 'CET-6 及以上',
  ielts: 'IELTS 及以上',
  gre: '仅 GRE',
};

function runHarness(url, level) {
  const extra = level === null ? [] : [`--level=${level}`];
  if (REPEAT !== null) extra.push(`--repeat=${REPEAT}`);
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'try-article.mjs'), url, '--json', '--top=0', ...extra],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 && result.stdout.trim() === '') {
    return { url, error: result.stderr.trim().split('\n').slice(-1)[0] ?? 'unknown error' };
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { url, error: `无法解析输出：${String(error)}` };
  }
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

async function collect(level) {
  const rows = [];
  for (const url of ARTICLES) {
    process.stderr.write(`  跑 [${level ?? '默认'}] ${url} …\n`);
    const report = runHarness(url, level);
    rows.push({
      url,
      title: report.title ?? '',
      regionChars: report.regionChars ?? 0,
      runningWords: report.runningWords ?? 0,
      contentCandidates: report.regionContentCandidates ?? 0,
      glossed: report.glossedInRegionUnique ?? 0,
      annotations: report.glossedTotal ?? 0,
      coverage: report.contentCoverage ?? 0,
      integrityOk: report.integrityOk ?? false,
      errors: report.errors?.length ?? 0,
      elapsedMs: report.elapsedMs ?? 0,
      error: report.error,
    });
  }
  return rows;
}

function summarize(rows) {
  const usable = rows.filter((row) => !row.error);
  const candidates = usable.reduce((sum, row) => sum + row.contentCandidates, 0);
  const glossed = usable.reduce((sum, row) => sum + row.glossed, 0);
  const annotations = usable.reduce((sum, row) => sum + row.annotations, 0);
  const words = usable.reduce((sum, row) => sum + row.runningWords, 0);
  return {
    usable: usable.length,
    total: rows.length,
    candidates,
    glossed,
    annotations,
    words,
    coverage: candidates === 0 ? 0 : glossed / candidates,
    per1000: words === 0 ? 0 : (annotations / words) * 1000,
    integrityOk: usable.every((row) => row.integrityOk),
    errors: usable.reduce((sum, row) => sum + row.errors, 0),
  };
}

/** 逐个生词线跑一遍，输出「标多少 / 有多密」的曲线——默认值就是照着这张表定的。 */
async function printLevelCurve() {
  const results = [];
  for (const level of LEVELS) {
    results.push({ level, summary: summarize(await collect(level)) });
  }
  console.log('');
  console.log('| 生词线 | 命中词元 | 插入释义 | 内容词覆盖率 | 阅读密度（每千词） | 完整性 |');
  console.log('| --- | ---: | ---: | ---: | ---: | :---: |');
  for (const { level, summary } of results) {
    console.log(
      `| ${LEVEL_LABELS[level]} | ${summary.glossed} | ${summary.annotations} | ${pct(summary.coverage)} | ${summary.per1000.toFixed(1)} 处（≈ 每 ${Math.round(summary.words / Math.max(1, summary.annotations))} 词一处） | ${summary.integrityOk ? '✓' : '✗'} |`,
    );
  }
  console.log('');
  console.log(
    `语料：${ARTICLES.length} 篇真实文章，合计 ${results[0]?.summary.words ?? 0} 运行词；异常 ${results.reduce((sum, item) => sum + item.summary.errors, 0)} 个`,
  );
}

async function main() {
  if (levelsMode) {
    await printLevelCurve();
    return;
  }

  const rows = await collect(null);

  const previous = compareFlag
    ? JSON.parse(await readFile(compareFlag.split('=')[1], 'utf8'))
    : null;
  const beforeByUrl = new Map((previous?.rows ?? []).map((row) => [row.url, row]));

  console.log('');
  console.log('| 文章 | 正文字符 | 内容词 | 命中 | 释义 | 内容词覆盖率 | 完整性 | 耗时 |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | :---: | ---: |');
  for (const row of rows) {
    if (row.error) {
      console.log(`| ${row.url.slice(0, 48)} | – | – | – | – | – | ✗ | – |`);
      continue;
    }
    const before = beforeByUrl.get(row.url);
    let delta = '';
    if (before && before.contentCandidates > 0) {
      const change = (row.coverage - before.coverage) * 100;
      const sign = change >= 0 ? '+' : '';
      delta = ` (${sign}${change.toFixed(1)}pp)`;
    }
    console.log(
      `| ${(row.title || row.url).slice(0, 40)} | ${row.regionChars} | ${row.contentCandidates} | ${row.glossed} | ${row.annotations} | ${pct(row.coverage)}${delta} | ${row.integrityOk ? '✓' : '✗'} | ${row.elapsedMs}ms |`,
    );
  }

  const usable = rows.filter((row) => !row.error);
  const totalCandidates = usable.reduce((sum, row) => sum + row.contentCandidates, 0);
  const totalGlossed = usable.reduce((sum, row) => sum + row.glossed, 0);
  console.log('');
  console.log(
    `合计：${usable.length}/${rows.length} 篇成功，内容词 ${totalCandidates}，命中 ${totalGlossed}，整体覆盖率 ${pct(totalGlossed / totalCandidates)}，完整性 ${usable.every((row) => row.integrityOk) ? '全部通过' : '有失败'}，异常 ${usable.reduce((sum, row) => sum + row.errors, 0)} 个`,
  );

  if (previous) {
    const beforeTotal = previous.totals;
    const change = (totalGlossed / totalCandidates - beforeTotal.coverage) * 100;
    console.log(
      `与 ${compareFlag.split('=')[1]} 相比：覆盖率 ${pct(beforeTotal.coverage)} → ${pct(totalGlossed / totalCandidates)}（${change >= 0 ? '+' : ''}${change.toFixed(1)}pp），命中 ${beforeTotal.glossed} → ${totalGlossed}`,
    );
  }

  if (saveFlag) {
    const target = saveFlag.split('=')[1];
    await writeFile(
      target,
      `${JSON.stringify({ at: new Date().toISOString(), rows, totals: { contentCandidates: totalCandidates, glossed: totalGlossed, coverage: totalGlossed / totalCandidates } }, null, 2)}\n`,
      'utf8',
    );
    console.log(`已存档 → ${target}`);
  }
}

await main();
