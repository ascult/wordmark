import {
  getSettings,
  updateSettings,
  getVocabList,
  exportJSON,
  exportCSV,
  importJSON,
  importCSV,
  importSampleVocab,
} from "../background/storage.js";

async function init(): Promise<void> {
  const settings = await getSettings();
  const vocab = await getVocabList();
  const toggle = document.getElementById("global-toggle") as HTMLInputElement;
  const matchCount = document.getElementById("match-count");
  const wordCount = document.getElementById("word-count");
  const manageBtn = document.getElementById("manage-btn");
  const importBtn = document.getElementById("import-btn");
  const exportBtn = document.getElementById("export-btn");
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const emptyState = document.getElementById("empty-state");
  const importSampleBtn = document.getElementById("import-sample-btn");

  toggle.checked = settings.enabled;

  if (wordCount) wordCount.textContent = String(vocab.length);

  if (vocab.length === 0 && emptyState) {
    emptyState.classList.remove("hidden");
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tabs[0].id, {
        type: "get-match-count",
      });
      if (matchCount) matchCount.textContent = String(response.count);
    } catch {
      // content script not loaded on this page
    }
  }

  toggle.addEventListener("change", async () => {
    const enabled = toggle.checked;
    await updateSettings({ enabled });
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "toggle-replace",
        payload: enabled,
      }).catch(() => {});
    }
  });

  manageBtn?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  importSampleBtn?.addEventListener("click", async () => {
    await importSampleVocab();
    await updateSettings({ importSampleDone: true });
    if (wordCount) wordCount.textContent = String((await getVocabList()).length);
    if (emptyState) emptyState.classList.add("hidden");
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "vocab-updated" }).catch(() => {});
    }
  });

  importBtn?.addEventListener("click", () => {
    fileInput?.click();
  });

  fileInput?.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    const isCSV = file.name.endsWith(".csv");
    try {
      const count = isCSV ? await importCSV(text) : await importJSON(text);
      if (wordCount) wordCount.textContent = String((await getVocabList()).length);
      if (emptyState) emptyState.classList.add("hidden");
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "vocab-updated" }).catch(() => {});
      }
    } catch (err) {
      alert(`导入失败: ${err}`);
    }
    fileInput.value = "";
  });

  exportBtn?.addEventListener("click", async () => {
    const vocab = await getVocabList();
    if (vocab.length === 0) return;
    const json = exportJSON(vocab);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "wordmark-vocab.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("test-page-btn")?.addEventListener("click", async () => {
    const url = chrome.runtime.getURL("test-page.html");
    await updateSettings({ enabled: true });
    const tab = await chrome.tabs.create({ url });
    // Wait for the page to finish loading
    await new Promise<void>((resolve) => {
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // If we missed the event, the page may already be loaded
      if (tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
    window.close();
  });
}

init();
