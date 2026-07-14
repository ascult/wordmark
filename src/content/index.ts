import { getStorageData } from "../background/storage.js";
import { isDomainAllowed } from "./dom-walker.js";
import { AhoCorasick } from "./matcher.js";
import { generateInflections, generateDerivations } from "./inflector.js";
import { replaceMatches, ANNOTATION_CLASS } from "./replacer.js";
import { getWordBounds } from "./tokenizer.js";
import { STOP_WORDS } from "../common/stop-words.js";
import type { VocabInfo, ExtensionMessage, VocabularyEntry } from "../common/types.js";
import { WORDS as CET4 } from "../common/cet4.js";
import { WORDS as CET6 } from "../common/cet6.js";

let currentEnabled = false;
let currentCET4 = false;
let currentCET6 = false;
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let batchInProgress = false;
let currentVocabList: VocabularyEntry[] = [];

async function init(): Promise<void> {
  const data = await getStorageData();
  currentEnabled = data.settings.enabled;
  currentCET4 = data.settings.cet4Enabled;
  currentCET6 = data.settings.cet6Enabled;
  currentVocabList = data.vocabList;

  if (currentEnabled && isDomainAllowed(data.settings)) {
    runReplacement();
  }

  setupMutationObserver();
}

function setupMutationObserver(): void {
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      if (currentEnabled) {
        runReplacement();
      }
    }, 500);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.vocabList) {
    getStorageData().then((data) => {
      currentEnabled = data.settings.enabled;
      currentCET4 = data.settings.cet4Enabled;
      currentCET6 = data.settings.cet6Enabled;
      currentVocabList = data.vocabList;
      if (currentEnabled && isDomainAllowed(data.settings)) {
        runReplacement();
      } else {
        undoReplacement();
      }
    });
  }
});

function buildVocabInfoMap(): Map<string, VocabInfo> {
  const map = new Map<string, VocabInfo>();

  if (currentCET4) {
    for (const word of CET4) {
      if (map.has(word)) continue;
      map.set(word, { definition: "", source: "cet" });
    }
  }

  if (currentCET6) {
    for (const word of CET6) {
      if (map.has(word)) continue;
      map.set(word, { definition: "", source: "cet" });
    }
  }

  for (const entry of currentVocabList) {
    const normalized = entry.word.toLowerCase().trim();
    if (!normalized || STOP_WORDS.has(normalized)) continue;
    map.set(normalized, { definition: entry.definition, source: "custom" });
  }

  return map;
}

function getPageSegments(): string[] {
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

function runReplacement(): void {
  const infoMap = buildVocabInfoMap();
  if (infoMap.size === 0) return;

  // Pass 1: only inflections, fast
  const patternMap = new Map<string, string[]>();
  for (const word of infoMap.keys()) {
    patternMap.set(word, generateInflections(word));
  }

  const matcher = new AhoCorasick(patternMap);
  replaceMatches(document.body, matcher, infoMap);

  // Scan body to find which CET words appear on this page
  const bodyText = (document.body.textContent || "").toLowerCase();
  const matcher1 = new AhoCorasick(patternMap);
  const wordBounds = getWordBounds(bodyText);
  const initialMatches = matcher1.search(bodyText, wordBounds);
  const foundWords = new Set(
    initialMatches
      .filter((m) => !STOP_WORDS.has(m.word))
      .map((m) => m.word)
  );

  // Pass 2: generate derivations only for words found on this page
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
    const derivedMatcher = new AhoCorasick(patternMap);
    replaceMatches(document.body, derivedMatcher, infoMap);
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

  if (missing.length > 0 && !batchInProgress) {
    batchInProgress = true;
    const segments = getPageSegments();
    fetchBatchDefinitions(missing, segments);
  }
}

async function fetchBatchDefinitions(
  words: string[],
  segments: string[]
): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "batch-translate",
      words,
      segments,
    });

    if (result?.definitions) {
      for (const [word, def] of Object.entries(result.definitions)) {
        if (typeof def === "string") {
          updateAnnotation(word, def);
        }
      }
    }
  } catch {
    // Batch failed silently
  } finally {
    batchInProgress = false;
  }
}

function updateAnnotation(word: string, definition: string): void {
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

function undoReplacement(): void {
  document.querySelectorAll(`.${ANNOTATION_CLASS}`).forEach((el) => {
    const text = el.getAttribute("data-original") || el.textContent || "";
    el.replaceWith(text);
  });
}

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, _sendResponse) => {
    switch (message.type) {
      case "vocab-updated":
        getStorageData().then((data) => {
          currentEnabled = data.settings.enabled;
          currentCET4 = data.settings.cet4Enabled;
          currentCET6 = data.settings.cet6Enabled;
          currentVocabList = data.vocabList;
          if (currentEnabled && isDomainAllowed(data.settings)) {
            runReplacement();
          } else {
            undoReplacement();
          }
        });
        break;
      case "toggle-replace":
        currentEnabled = message.payload as boolean;
        if (currentEnabled) {
          runReplacement();
        } else {
          undoReplacement();
        }
        break;
      case "get-match-count":
        _sendResponse({
          count: document.querySelectorAll(`.${ANNOTATION_CLASS}`).length,
        });
        break;
    }
  }
);

init();
