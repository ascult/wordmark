import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import dictJson from '../src/data/dict.zh.json';
import type { DictEntry } from '../src/core/types.js';

const DICT = dictJson as unknown as DictEntry[];
const HEADS = new Set(DICT.map((entry) => entry.word));
// vitest 的 jsdom 环境里 `import.meta.url` 不是 file: 协议，按工作目录定位（= 仓库根）
const SENSES_DIR = path.join(process.cwd(), 'data', 'senses');
const FILES = readdirSync(SENSES_DIR).filter((name) => name.endsWith('.json'));

/** 生成器的结构上限：义项由最多 3 个「原子」用 `/` 连接，单原子 ≤10 字。 */
const MAX_SENSE_CHARS = 32;
const MAX_SENSES_PER_WORD = 6;

function loadTables(): Array<{ file: string; table: Record<string, string[]> }> {
  return FILES.map((file) => ({
    file,
    table: JSON.parse(readFileSync(`${SENSES_DIR}/${file}`, 'utf8')) as Record<string, string[]>,
  }));
}

describe('多义项表：打分服务的必需输入', () => {
  it('至少有一份表，且每个词元都能在词表里找到', () => {
    expect(FILES.length).toBeGreaterThan(0);
    for (const { file, table } of loadTables()) {
      for (const word of Object.keys(table)) {
        expect(HEADS.has(word), `${file} 里的 ${word} 不在词表里`).toBe(true);
      }
    }
  });

  it('义项符合 shape：非空、含中文、不超过结构上限、不重复', () => {
    for (const { file, table } of loadTables()) {
      for (const [word, senses] of Object.entries(table)) {
        expect(Array.isArray(senses), `${file}:${word}`).toBe(true);
        expect(senses.length, `${file}:${word} 义项条数`).toBeGreaterThan(0);
        expect(senses.length, `${file}:${word} 义项条数`).toBeLessThanOrEqual(MAX_SENSES_PER_WORD);
        for (const sense of senses) {
          expect(sense, `${file}:${word} 的义项必须含中文`).toMatch(/[\u4e00-\u9fff]/);
          expect([...sense].length, `${file}:${word} → ${sense}`).toBeLessThanOrEqual(MAX_SENSE_CHARS);
        }
        expect(new Set(senses).size, `${file}:${word} 有重复义项`).toBe(senses.length);
      }
    }
  });

  it('规模达到可用水平，且相当一部分词确实多义', () => {
    const tables = loadTables();
    const words = tables.reduce((sum, { table }) => sum + Object.keys(table).length, 0);
    const multi = tables.reduce(
      (sum, { table }) => sum + Object.values(table).filter((senses) => senses.length >= 2).length,
      0,
    );
    expect(words).toBeGreaterThanOrEqual(2000);
    expect(multi).toBeGreaterThanOrEqual(words * 0.5);
  });
});
