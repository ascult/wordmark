/**
 * 标注决策层（纯函数，便于单测）。
 *
 * 「生词」的判定完全由数据决定，而不是猜用户会不会：
 * 1) 词元的难度等级低于阈值 → 视为已知，跳过（阈值就是「生词线」）；
 * 2) 命中用户的已知词表 → 跳过；
 * 3) 其余命中词典的词 → 标注。
 */

import type { RepeatMode } from './settings.js';
import { LEVEL_RANK, type Level } from './types.js';

export interface AnnotatePolicy {
  annotateFrom: Level;
  knownWords: ReadonlySet<string>;
}

export function isHardEnough(level: Level | undefined, annotateFrom: Level): boolean {
  // 没有等级信息（例如在线释义）时不做难度过滤，交给用户开关决定。
  if (level === undefined) return true;
  return LEVEL_RANK[level] >= LEVEL_RANK[annotateFrom];
}

export function shouldAnnotate(
  lemma: string,
  level: Level | undefined,
  policy: Pick<AnnotatePolicy, 'annotateFrom' | 'knownWords'>,
): boolean {
  if (policy.knownWords.has(lemma)) return false;
  return isHardEnough(level, policy.annotateFrom);
}

/** 控制同页重复标注：默认每个词元只标第一次，避免整页都是中文。 */
export class RepeatTracker {
  readonly #counts = new Map<string, number>();

  constructor(private readonly mode: RepeatMode) {}

  /** 该词元现在是否还应该标注（不改变状态）。 */
  allows(lemma: string): boolean {
    if (this.mode === 'all') return true;
    return (this.#counts.get(lemma) ?? 0) === 0;
  }

  /** 记录一次已插入的标注。 */
  note(lemma: string): void {
    this.#counts.set(lemma, (this.#counts.get(lemma) ?? 0) + 1);
  }

  count(lemma: string): number {
    return this.#counts.get(lemma) ?? 0;
  }

  clear(): void {
    this.#counts.clear();
  }
}
