/**
 * 轻量英文词形还原。
 *
 * 目标不是语言学正确，而是「给出有序候选词元」：registry 会按顺序
 * 逐个查词，第一个命中的候选即为结果。因此规则可以宽松——多余的
 * 候选只会浪费一次哈希查找，不会污染结果。
 */

import { normalizeToken, stripClitics } from './tokenizer.js';

/**
 * 高频不规则形式。词典中的 `alt` 字段也能覆盖同类情况，
 * 这里只放「不写会明显影响体验」的高频词。
 */
const IRREGULAR: Record<string, string> = {
  // 不规则名词复数
  children: 'child',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  people: 'person',
  lives: 'life',
  knives: 'knife',
  wives: 'wife',
  leaves: 'leaf',
  halves: 'half',
  shelves: 'shelf',
  wolves: 'wolf',
  thieves: 'thief',
  criteria: 'criterion',
  phenomena: 'phenomenon',
  data: 'datum',
  media: 'medium',
  analyses: 'analysis',
  crises: 'crisis',
  theses: 'thesis',
  hypotheses: 'hypothesis',
  indices: 'index',
  matrices: 'matrix',
  vertices: 'vertex',
  // 不规则动词
  am: 'be',
  is: 'be',
  are: 'be',
  was: 'be',
  were: 'be',
  been: 'be',
  being: 'be',
  has: 'have',
  had: 'have',
  having: 'have',
  does: 'do',
  did: 'do',
  done: 'do',
  doing: 'do',
  goes: 'go',
  went: 'go',
  gone: 'go',
  said: 'say',
  made: 'make',
  took: 'take',
  taken: 'take',
  came: 'come',
  saw: 'see',
  seen: 'see',
  knew: 'know',
  known: 'know',
  got: 'get',
  gotten: 'get',
  gave: 'give',
  given: 'give',
  found: 'find',
  thought: 'think',
  told: 'tell',
  became: 'become',
  left: 'leave',
  felt: 'feel',
  put: 'put',
  brought: 'bring',
  began: 'begin',
  begun: 'begin',
  kept: 'keep',
  held: 'hold',
  wrote: 'write',
  written: 'write',
  stood: 'stand',
  heard: 'hear',
  let: 'let',
  meant: 'mean',
  met: 'meet',
  ran: 'run',
  paid: 'pay',
  sat: 'sit',
  spoke: 'speak',
  spoken: 'speak',
  lay: 'lie',
  led: 'lead',
  grew: 'grow',
  grown: 'grow',
  lost: 'lose',
  fell: 'fall',
  fallen: 'fall',
  sent: 'send',
  built: 'build',
  understood: 'understand',
  drew: 'draw',
  drawn: 'draw',
  broke: 'break',
  broken: 'break',
  spent: 'spend',
  cut: 'cut',
  rose: 'rise',
  risen: 'rise',
  drove: 'drive',
  driven: 'drive',
  bought: 'buy',
  wore: 'wear',
  worn: 'wear',
  chose: 'choose',
  chosen: 'choose',
  ate: 'eat',
  eaten: 'eat',
  // 不规则比较级
  better: 'good',
  best: 'good',
  worse: 'bad',
  worst: 'bad',
  more: 'much',
  most: 'much',
  less: 'little',
  least: 'little',
  further: 'far',
  furthest: 'far',
};

/** 去重并保持插入顺序。 */
function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length >= 2 && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function pushSuffixCandidates(base: string, out: string[]): void {
  // 重复辅音结尾：running → run，stopped → stop
  if (/([bdfglmnprt])\1$/.test(base)) {
    out.push(base.slice(0, -1));
  }
  // 以 e 结尾的动词：making → make
  out.push(`${base}e`);
}

/**
 * 返回有序的词元候选（含原始词形本身）。
 * 调用方应依次查询，取第一个命中项。
 */
export function lemmaCandidates(rawToken: string): string[] {
  const normalized = normalizeToken(rawToken);
  const out: string[] = [normalized];

  const irregular = IRREGULAR[normalized];
  if (irregular) out.push(irregular);

  const stem = stripClitics(normalized);
  if (stem !== normalized) out.push(stem);

  const base = stem;

  if (base.endsWith('ies') && base.length > 4) {
    out.push(`${base.slice(0, -3)}y`);
  }
  if (base.endsWith('ves') && base.length > 4) {
    out.push(`${base.slice(0, -3)}f`);
    out.push(`${base.slice(0, -3)}fe`);
  }
  if (base.endsWith('es') && base.length > 3) {
    const body = base.slice(0, -2);
    out.push(body);
    pushSuffixCandidates(body, out);
    // boxes → box（上面已覆盖）；watches → watch
    if (/(ch|sh|ss|x|z)$/.test(body)) out.push(body);
  }
  if (base.endsWith('s') && !base.endsWith('ss') && base.length > 3) {
    out.push(base.slice(0, -1));
  }
  if (base.endsWith('ied') && base.length > 4) {
    out.push(`${base.slice(0, -3)}y`);
  }
  if (base.endsWith('ed') && base.length > 3) {
    const body = base.slice(0, -2);
    pushSuffixCandidates(body, out);
    out.push(body);
  }
  if (base.endsWith('ing') && base.length > 4) {
    const body = base.slice(0, -3);
    pushSuffixCandidates(body, out);
    out.push(body);
  }
  if (base.endsWith('est') && base.length > 4) {
    const body = base.slice(0, -3);
    pushSuffixCandidates(body, out);
    out.push(body);
  }
  if (base.endsWith('er') && base.length > 4) {
    const body = base.slice(0, -2);
    pushSuffixCandidates(body, out);
    out.push(body);
  }
  if (base.endsWith('ly') && base.length > 4) {
    const body = base.slice(0, -2);
    out.push(body);
    if (body.endsWith('i')) out.push(`${body.slice(0, -1)}y`);
  }
  if (base.endsWith('ation') && base.length > 6) {
    // creation → create / declaration → declare
    out.push(`${base.slice(0, -3)}e`);
  }
  if (base.endsWith('isation') && base.length > 7) {
    out.push(`${base.slice(0, -7)}ise`);
  }
  if (base.endsWith('ization') && base.length > 7) {
    out.push(`${base.slice(0, -7)}ize`);
  }
  if (base.endsWith('ment') && base.length > 5) {
    out.push(base.slice(0, -4));
  }
  if (base.endsWith('ness') && base.length > 5) {
    out.push(base.slice(0, -4));
    if (base.endsWith('iness')) out.push(`${base.slice(0, -5)}y`);
  }

  return unique(out);
}
