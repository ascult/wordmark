export function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/([。！？；])/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildWordSentenceMap(
  enSentences: string[],
  zhSentences: string[]
): Map<number, string> {
  const map = new Map<number, string>();
  const n = Math.min(enSentences.length, zhSentences.length);
  for (let i = 0; i < n; i++) {
    map.set(i, zhSentences[i]);
  }
  if (enSentences.length > zhSentences.length) {
    const lastZh = zhSentences.length > 0 ? zhSentences[zhSentences.length - 1] : "";
    for (let i = zhSentences.length; i < enSentences.length; i++) {
      map.set(i, lastZh);
    }
  }
  if (zhSentences.length > enSentences.length) {
    const lastEn = enSentences.length > 0 ? enSentences.length - 1 : 0;
    for (let i = enSentences.length; i < zhSentences.length; i++) {
      map.set(lastEn, map.get(lastEn) + zhSentences[i]);
    }
  }
  return map;
}

export function findEnglishSentence(
  word: string,
  enSentences: string[]
): string | undefined {
  const lower = word.toLowerCase();
  for (const s of enSentences) {
    if (s.toLowerCase().includes(lower)) return s;
  }
  return undefined;
}

export function findChineseSentence(
  word: string,
  enSentences: string[],
  wordSentenceMap: Map<number, string>
): string | undefined {
  const lower = word.toLowerCase();
  for (let i = 0; i < enSentences.length; i++) {
    if (enSentences[i].toLowerCase().includes(lower)) {
      return wordSentenceMap.get(i);
    }
  }
  return undefined;
}

export function findClosestMatch(
  enWord: string,
  enSentence: string,
  zhSentence: string,
  cnWords: string[]
): string | undefined {
  const enLower = enWord.toLowerCase();
  const enTokens = enSentence.toLowerCase().split(/\s+/);

  let wordIdx = -1;
  for (let i = 0; i < enTokens.length; i++) {
    if (enTokens[i] === enLower || enTokens[i].startsWith(enLower)) {
      wordIdx = i;
      break;
    }
  }
  if (wordIdx < 0) return undefined;

  const zhChars = [...zhSentence.replace(/[，。！？、；：""''（）]/g, "")];
  if (zhChars.length === 0) return undefined;

  const estPos = Math.round((wordIdx / enTokens.length) * zhChars.length);

  const candidates = cnWords
    .map((cn) => ({ word: cn, pos: zhSentence.indexOf(cn) }))
    .filter((c) => c.pos >= 0);

  if (candidates.length > 0) {
    candidates.sort(
      (a, b) => Math.abs(a.pos - estPos) - Math.abs(b.pos - estPos)
    );
    return candidates[0].word;
  }

  const charMatches: { word: string; score: number }[] = [];
  for (const cn of cnWords) {
    const chars = [...cn];
    let matched = 0;
    for (const c of chars) {
      if (zhSentence.includes(c)) matched++;
    }
    if (matched > 0)
      charMatches.push({ word: cn, score: matched / chars.length });
  }
  if (charMatches.length > 0) {
    charMatches.sort((a, b) => b.score - a.score);
    return charMatches[0].word;
  }

  const segStart = Math.max(0, estPos - 1);
  const segEnd = Math.min(zhChars.length, segStart + 3);
  return zhChars.slice(segStart, segEnd).join("");
}
