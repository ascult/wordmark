import { getStorageData } from "../background/storage.js";
import { isDomainAllowed } from "./dom-walker.js";
import {
  buildVocabInfoMap,
  getPageSegments,
  annotatePage,
  updateAnnotation,
  undoReplacement,
  ANNOTATION_CLASS,
} from "./engine.js";
import type { ExtensionMessage, VocabularyEntry } from "../common/types.js";

let currentEnabled = false;
let currentCET4 = false;
let currentCET6 = false;
let currentVocabList: VocabularyEntry[] = [];
let mutationTimer: ReturnType<typeof setTimeout> | null = null;
let batchInProgress = false;

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
      if (currentEnabled) runReplacement();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });
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

function runReplacement(): void {
  const infoMap = buildVocabInfoMap(currentCET4, currentCET6, currentVocabList);
  if (infoMap.size === 0) return;

  const { missing } = annotatePage(infoMap);

  if (missing.length > 0 && !batchInProgress) {
    batchInProgress = true;
    fetchBatchDefinitions(missing, getPageSegments());
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
        if (typeof def === "string") updateAnnotation(word, def);
      }
    }
  } catch {
    // Batch failed silently
  } finally {
    batchInProgress = false;
  }
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
        if (currentEnabled) runReplacement();
        else undoReplacement();
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

