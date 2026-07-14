import { getStorageData } from "../background/storage.js";
import { isDomainAllowed } from "./dom-walker.js";
import { AhoCorasick } from "./matcher.js";
import { generateInflections } from "./inflector.js";
import { replaceMatches, ANNOTATION_CLASS } from "./replacer.js";
import { getWordBounds } from "./tokenizer.js";
import { STOP_WORDS } from "../common/stop-words.js";
import type { VocabInfo, ExtensionMessage } from "../common/types.js";
import { WORDS as CET4 } from "../common/cet4.js";
import { WORDS as CET6 } from "../common/cet6.js";

let currentEnabled = false;
let currentCET4 = false;
let currentCET6 = false;

async function init(): Promise<void> {
  const data = await getStorageData();
  currentEnabled = data.settings.enabled;
  currentCET4 = data.settings.cet4Enabled;
  currentCET6 = data.settings.cet6Enabled;

  if (currentEnabled && isDomainAllowed(data.settings)) {
    runReplacement();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    getStorageData().then((data) => {
      currentEnabled = data.settings.enabled;
      currentCET4 = data.settings.cet4Enabled;
      currentCET6 = data.settings.cet6Enabled;
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

  return map;
}

function getPageText(): string {
  const blocks = document.querySelectorAll(
    "p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, caption, div"
  );
  const parts: string[] = [];
  for (const el of blocks) {
    const text = (el as HTMLElement).textContent?.trim();
    if (text && text.length > 5) parts.push(text);
  }
  return parts.join("\n");
}

function runReplacement(): void {
  const infoMap = buildVocabInfoMap();
  if (infoMap.size === 0) return;

  const patternMap = new Map<string, string[]>();
  for (const word of infoMap.keys()) {
    patternMap.set(word, generateInflections(word));
  }
  const matcher = new AhoCorasick(patternMap);
  replaceMatches(document.body, matcher, infoMap);

  // Scan DOM text directly to find which CET words appear on this page
  const bodyText = (document.body.textContent || "").toLowerCase();
  const matcher2 = new AhoCorasick(patternMap);
  const wordBounds = getWordBounds(bodyText);
  const rawMatches = matcher2.search(bodyText, wordBounds);
  const foundWords = new Set(
    rawMatches
      .filter((m) => !STOP_WORDS.has(m.word))
      .map((m) => m.word)
  );

  const missing: string[] = [];
  for (const word of infoMap.keys()) {
    if (foundWords.has(word)) missing.push(word);
  }

  if (missing.length > 0) {
    const pageText = getPageText();
    fetchBatchDefinitions(missing, pageText);
  }
}

async function fetchBatchDefinitions(
  words: string[],
  pageText: string
): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({
      type: "batch-translate",
      words,
      pageText,
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
  }
}

function updateAnnotation(word: string, definition: string): void {
  const variants = new Set(
    generateInflections(word).map((w) => w.toLowerCase())
  );
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
