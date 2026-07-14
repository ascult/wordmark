import { bingTranslate } from "./bing.js";
import { lookup } from "../common/dict.js";
import {
  splitSentences,
  buildWordSentenceMap,
  findEnglishSentence,
  findChineseSentence,
  findClosestMatch,
} from "./sentence.js";

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
