import { AhoCorasick } from "./matcher.js";
import { generateInflections, generateDerivations } from "./inflector.js";
import { replaceMatches, ANNOTATION_CLASS } from "./replacer.js";
import { getWordBounds } from "./tokenizer.js";
import { STOP_WORDS } from "../common/stop-words.js";
import { WORDS as CET4 } from "../common/cet4.js";
import { WORDS as CET6 } from "../common/cet6.js";
import type { VocabInfo, VocabularyEntry } from "../common/types.js";

export { ANNOTATION_CLASS };

export function buildVocabInfoMap(
  cet4Enabled: boolean,
  cet6Enabled: boolean,
  vocabList: VocabularyEntry[]
): Map<string, VocabInfo> {
  const map = new Map<string, VocabInfo>();

  if (cet4Enabled) {
    for (const word of CET4) {
      if (map.has(word)) continue;
      map.set(word, { definition: "", source: "cet" });
    }
  }

  if (cet6Enabled) {
    for (const word of CET6) {
      if (map.has(word)) continue;
      map.set(word, { definition: "", source: "cet" });
    }
  }

  for (const entry of vocabList) {
    const normalized = entry.word.toLowerCase().trim();
    if (!normalized || STOP_WORDS.has(normalized)) continue;
    map.set(normalized, { definition: entry.definition, source: "custom" });
  }

  return map;
}

export function getPageSegments(): string[] {
  const blocks = document.querySelectorAll(
    "p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, caption"
  );
  const segments: string[] = [];
  let current = "";
  for (const el of blocks) {
    if (el.tagName === "LI" && el.querySelector("input")) continue;
    const text = (el as HTMLElement).textContent?.trim();
    if (!text || text.length <= 5) continue;
    if (current.length + text.length > 500) {
      segments.push(current);
      current = text;
      if (segments.length >= 20) break;
    } else {
      current += (current ? "\n" : "") + text;
    }
  }
  if (current && segments.length < 20) segments.push(current);

  const seen = new Set<string>();
  return segments.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

export function annotatePage(
  infoMap: Map<string, VocabInfo>
): { missing: string[]; derivedToBase: Map<string, string> } {
  // Pass 1: only inflections
  const patternMap = new Map<string, string[]>();
  for (const word of infoMap.keys()) {
    patternMap.set(word, generateInflections(word));
  }

  const matcher = new AhoCorasick(patternMap);
  replaceMatches(document.body, matcher, infoMap);

  const bodyText = (document.body.textContent || "").toLowerCase();
  const wordBounds = getWordBounds(bodyText);
  const initialMatches = new AhoCorasick(patternMap).search(bodyText, wordBounds);
  const foundWords = new Set(
    initialMatches
      .filter((m) => !STOP_WORDS.has(m.word))
      .map((m) => m.word)
  );

  // Pass 2: derivations only for words on this page
  const derivedToBase = new Map<string, string>();
  for (const word of foundWords) {
    for (const derived of generateDerivations(word)) {
      if (!patternMap.has(derived) && !infoMap.has(derived)) {
        patternMap.set(derived, [derived]);
        derivedToBase.set(derived, word);
        infoMap.set(derived, { definition: "", source: "cet" });
      }
    }
  }

  if (derivedToBase.size > 0) {
    replaceMatches(document.body, new AhoCorasick(patternMap), infoMap);
  }

  const rawMatches = new AhoCorasick(patternMap).search(bodyText, wordBounds);
  const foundSet = new Set(
    rawMatches
      .filter((m) => !STOP_WORDS.has(m.word))
      .map((m) => m.word)
  );

  const missing: string[] = [];
  for (const word of infoMap.keys()) {
    if (foundSet.has(word)) missing.push(word);
  }
  for (const match of rawMatches) {
    const base = derivedToBase.get(match.word);
    if (base && !missing.includes(base)) {
      missing.push(base);
    }
  }

  return { missing, derivedToBase };
}

export function updateAnnotation(word: string, definition: string): void {
  const variants = new Set(
    generateInflections(word).map((w) => w.toLowerCase())
  );
  for (const derived of generateDerivations(word)) {
    variants.add(derived.toLowerCase());
  }
  const marks = document.querySelectorAll<HTMLElement>(
    `mark.${ANNOTATION_CLASS}`
  );
  for (const mark of marks) {
    const orig = (mark.getAttribute("data-original") || "").toLowerCase();
    if (!variants.has(orig)) continue;
    const original = mark.getAttribute("data-original") || "";
    mark.textContent = `${original}(${definition})`;
  }
}

export function undoReplacement(): void {
  document.querySelectorAll(`.${ANNOTATION_CLASS}`).forEach((el) => {
    const text = el.getAttribute("data-original") || el.textContent || "";
    el.replaceWith(text);
  });
}
