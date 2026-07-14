import { bingTranslate } from "./bing.js";
import { lookup } from "../common/dict.js";

export async function translate(word: string): Promise<string> {
  const entry = lookup(word);
  return entry?.def ?? "";
}

const CONCURRENCY = 3;
const CACHE_TTL = 60 * 60 * 1000;
const MAX_EMPTY_STREAK = 3;

const segmentCache = new Map<string, { zhText: string; timestamp: number }>();

function hashSegment(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash.toString(36);
}

export async function batchTranslate(
  words: string[],
  segments: string[]
): Promise<Record<string, string>> {
  if (words.length === 0) return {};
  if (segments.length === 0) return {};

  const result: Record<string, string> = {};
  let emptyStreak = 0;

  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = segments.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (seg) => {
        try {
          return await translateSegment(words, seg, result);
        } catch {
          return {};
        }
      })
    );

    let batchHasResults = false;
    for (const r of batchResults) {
      if (Object.keys(r).length > 0) batchHasResults = true;
      for (const [word, def] of Object.entries(r)) {
        if (!result[word]) result[word] = def;
      }
    }

    if (batchHasResults) {
      emptyStreak = 0;
    } else {
      emptyStreak++;
      if (emptyStreak >= MAX_EMPTY_STREAK) break;
    }
  }

  for (const word of words) {
    if (!result[word]) {
      const entry = lookup(word);
      result[word] = entry?.cn[0] ?? entry?.def ?? "";
    }
  }

  return result;
}

async function translateSegment(
  words: string[],
  segment: string,
  existing: Record<string, string>
): Promise<Record<string, string>> {
  const relevant = words.filter((w) =>
    !existing[w] && segment.toLowerCase().includes(w)
  );
  if (relevant.length === 0) return {};

  const text = segment.length > 950
    ? segment.slice(0, 947) + "..."
    : segment;

  const segHash = hashSegment(text);
  const cached = segmentCache.get(segHash);
  let chinesePage: string;
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    chinesePage = cached.zhText;
  } else {
    try {
      chinesePage = await bingTranslate(text);
    } catch {
      return {};
    }
    if (!chinesePage) return {};
    segmentCache.set(segHash, { zhText: chinesePage, timestamp: Date.now() });
  }

  const enSentences = splitSentences(text);
  const zhSentences = splitSentences(chinesePage);
  const wordSentenceMap = buildWordSentenceMap(enSentences, zhSentences);
  const result: Record<string, string> = {};

  for (const word of relevant) {
    const zhSentence = findChineseSentence(word, enSentences, wordSentenceMap);
    if (!zhSentence) {
      const entry = lookup(word);
      if (entry) result[word] = entry.cn[0] ?? entry.def;
      continue;
    }

    const enSentence = findEnglishSentence(word, enSentences);
    const entry = lookup(word);
    if (entry?.cn.length && enSentence) {
      const matched = findClosestMatch(word, enSentence, zhSentence, entry.cn);
      if (matched && entry.cn.includes(matched)) {
        result[word] = matched;
      }
    } else if (entry?.cn.length) {
      result[word] = entry.cn[0];
    } else {
      result[word] = zhSentence;
    }
  }

  return result;
}

function findClosestMatch(
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

function findEnglishSentence(
  word: string,
  enSentences: string[]
): string | undefined {
  const lower = word.toLowerCase();
  for (const s of enSentences) {
    if (s.toLowerCase().includes(lower)) return s;
  }
  return undefined;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/([.!?])\s+/g, "$1\n")
    .replace(/([。！？；])/g, "$1\n")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function buildWordSentenceMap(
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

function findChineseSentence(
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
