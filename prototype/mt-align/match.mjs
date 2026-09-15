/**
 * 原型：把词典义「匹配」到实际那句译文上。
 *
 * 【原型代码，不是生产实现】
 *
 * 思路（用户提的方向）：词典义是**锚点**，实际译文是**证据**。
 * 对每个候选词，用它的词典义（拆成义项）去实际译文里找对应片段：
 *   - 找得到 → 那个片段就是该词在这句话里的意思，直接拿来标注；
 *     因此标注天然与「这句话实际被翻成了什么」一致；
 *   - 找不到 → 词典义在这句话里对不上（要么语境义不同，要么翻译时被省略），
 *     这本身是有价值的信号，而不是硬塞一个可能错的释义。
 *
 * 匹配分三级，从严到宽：
 *   exact —— 义项原样出现在译文里
 *   lcs   —— 义项与译文的最长公共子串够长（如义项「取消计划」对上译文里的「取消」）
 *   none  —— 够不上阈值，判定为对不上
 *
 * 位置信息只用来在同分候选之间取舍（中英文语序大体单调，但只作弱约束）。
 */

/** 把一条词典释义拆成可独立匹配的义项。 */
export function splitSenses(gloss) {
  return String(gloss)
    .split(/[、，,；;（）()]/)
    .map((part) => part.trim())
    .filter((part) => [...part].length >= 2);
}

/** 最长公共子串（返回子串本身）。中文按字符比较。 */
export function longestCommonSubstring(a, b) {
  const left = [...a];
  const right = [...b];
  let best = '';
  // 滚动数组，O(len(a)*len(b))；句子级长度完全够用
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best.length) best = right.slice(j - current[j], j).join('');
      }
    }
    previous = current;
  }
  return best;
}

/** 单个义项 vs 整句译文 的匹配。 */
export function matchCandidate(candidate, translation, { minLcs = 2 } = {}) {
  if (candidate === '' || translation === '') return null;
  if (translation.includes(candidate)) {
    return { span: candidate, score: 1, kind: 'exact', position: translation.indexOf(candidate) };
  }
  const lcs = longestCommonSubstring(candidate, translation);
  const length = [...lcs].length;
  if (length < minLcs) return null;
  const score = length / [...candidate].length;
  return { span: lcs, score, kind: 'lcs', position: translation.indexOf(lcs) };
}

/**
 * 一个词 vs 整句译文：在所有义项里挑最好的匹配。
 * positionRatio 是该词在源句内容词里的相对位置，用于同分取舍。
 */
export function matchWord(gloss, translation, { positionRatio = 0.5, minScore = 0.5 } = {}) {
  const senses = splitSenses(gloss);
  let best = null;
  for (const sense of senses) {
    const hit = matchCandidate(sense, translation);
    if (!hit || hit.score < minScore) continue;
    // 期望位置：按源句相对位置折算到译文长度
    const expected = positionRatio * [...translation].length;
    const distance = hit.position < 0 ? Number.POSITIVE_INFINITY : Math.abs(hit.position - expected);
    const key = hit.score * 100 - Math.min(distance, 20) / 100; // 分数优先，距离只做微调
    if (best === null || key > best.key) best = { ...hit, sense, key };
  }
  return best;
}

/** 整句对齐：返回 词 → 匹配结果。 */
export function alignSentence({ words, dictionary, translation, minScore = 0.5 }) {
  const matches = new Map();
  const content = words.filter((word) => dictionary.has(word));
  content.forEach((word, index) => {
    const ratio = content.length <= 1 ? 0.5 : index / (content.length - 1);
    const hit = matchWord(dictionary.get(word).gloss, translation, { positionRatio: ratio, minScore });
    if (hit) matches.set(word, hit);
  });
  return matches;
}
