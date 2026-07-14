import { getStorageData } from "../background/storage.js";
import { isDomainAllowed } from "./dom-walker.js";
import { buildMatcher, MatchResult } from "./matcher.js";
import { replaceMatches } from "./replacer.js";
import type { VocabularyEntry, ExtensionMessage } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

let currentVocab: VocabularyEntry[] = [];
let currentEnabled = false;

async function init(): Promise<void> {
  const data = await getStorageData();
  currentVocab = data.vocabList;
  currentEnabled = data.settings.enabled;

  if (currentEnabled && isDomainAllowed(data.settings)) {
    runReplacement();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings || changes.vocabList) {
    getStorageData().then((data) => {
      currentVocab = data.vocabList;
      currentEnabled = data.settings.enabled;
      if (currentEnabled && isDomainAllowed(data.settings)) {
        runReplacement();
      } else {
        undoReplacement();
      }
    });
  }
});

function runReplacement(): void {
  if (currentVocab.length === 0) return;

  const matcher = buildMatcher(currentVocab);
  const vocabMap = new Map(currentVocab.map((e) => [e.word, e]));
  replaceMatches(document.body, matcher, vocabMap);
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
          currentVocab = data.vocabList;
          currentEnabled = data.settings.enabled;
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
