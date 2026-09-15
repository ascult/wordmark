/**
 * 共享类型定义。
 *
 * 该文件只包含类型与常量，不产生副作用，可被 content script、
 * service worker、popup、options 以及测试共用。
 */

/**
 * 难度等级，由易到难。
 *
 * `basic` 是「几乎人人认识的常用词」——默认不标注，只有把生词线调到
 * basic 才会一起标出来（备考精读模式）。它存在的意义是：从外部词库
 * 导入的整表 CET-4 里混着 ability / action 这类常见词，如果不单独分层，
 * 要么默认标注过密，要么整表都用不上。
 */
export const LEVELS = ['basic', 'cet4', 'cet6', 'ielts', 'gre'] as const;

export type Level = (typeof LEVELS)[number];

/** 难度排序值，越大越难。 */
export const LEVEL_RANK: Record<Level, number> = {
  basic: 0,
  cet4: 1,
  cet6: 2,
  ielts: 3,
  gre: 4,
};

export const LEVEL_LABELS: Record<Level, string> = {
  basic: '基础',
  cet4: 'CET-4',
  cet6: 'CET-6',
  ielts: 'IELTS',
  gre: 'GRE',
};

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

/** 内置离线词表的一条记录。 */
export interface DictEntry {
  /** 小写词元，仅 ASCII 字母。 */
  word: string;
  /** 词性缩写，如 "n." / "v." / "adj."。 */
  pos: string;
  /** 简体中文释义。 */
  gloss: string;
  /** 难度等级。 */
  level: Level;
  /** 不规则变体（如 child → children），用于反查。 */
  alt?: string[];
}

/** 词典来源标识。 */
export type ProviderId = 'offline' | 'mymemory' | 'custom';

/** 一次成功查询的结果。 */
export interface LookupResult {
  /** 词元（词典头词）。 */
  lemma: string;
  /** 网页中出现的原始写法。 */
  surface: string;
  /** 中文释义。 */
  gloss: string;
  /** 词性，可能缺失。 */
  pos?: string;
  /** 难度等级，仅离线词表提供。 */
  level?: Level;
  /** 命中的 provider id。 */
  source: ProviderId;
  /** 结果产生时间戳（毫秒）。 */
  at: number;
}

/** 可插拔的词典 provider。 */
export interface DictionaryProvider {
  readonly id: ProviderId;
  /**
   * `local` 由 registry 负责按词元候选逐个尝试；
   * `remote` 只会在所有 local provider 失败后按原始词形调用一次。
   */
  readonly kind: 'local' | 'remote';
  /** 是否可用（例如用户是否启用）。 */
  available(): boolean;
  lookup(query: string, signal?: AbortSignal): Promise<LookupResult | null>;
  /**
   * 可选同步快路径。内置词表就是个 Map，能同步命中就没必要
   * 走微任务队列——整页标注可以省下成千上万次 await。
   */
  lookupSync?(query: string): LookupResult | null;
}
