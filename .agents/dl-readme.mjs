import { chromium } from 'playwright';
import fs from 'node:fs';

const repos = [
  { repo: 'facebook/react', file: 'README.md' },
  { repo: 'freeCodeCamp/freeCodeCamp', file: 'README.md' },
  { repo: 'microsoft/vscode', file: 'README.md' },
  { repo: 'twbs/bootstrap', file: 'README.md' },
];

const browser = await chromium.launch({ headless: true });

for (const { repo, file } of repos) {
  const name = repo.split('/')[1];
  const url = `https://raw.githubusercontent.com/${repo}/refs/heads/main/${file}`;
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (resp && resp.ok()) {
      const text = await page.evaluate(() => document.body.textContent || '');
      const out = `src/__tests__/fixtures/${name}.md`;
      fs.mkdirSync('src/__tests__/fixtures', { recursive: true });
      fs.writeFileSync(out, text);
      console.log(`${name}: ${text.length} chars → ${out}`);
    } else {
      console.log(`${name}: HTTP ${resp?.status()}`);
    }
  } catch (e) {
    console.log(`${name}: ${e.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
