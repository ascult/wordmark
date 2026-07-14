import {
  getSettings,
  updateSettings,
  getVocabList,
  exportJSON,
  exportCSV,
  importJSON,
  importCSV,
} from "../background/storage.js";
import { WORDS as CET4 } from "../common/cet4.js";
import { WORDS as CET6 } from "../common/cet6.js";

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
  const cet4Toggle = document.getElementById("cet4-toggle") as HTMLInputElement;
  const cet6Toggle = document.getElementById("cet6-toggle") as HTMLInputElement;
  const cet4Count = document.getElementById("cet4-count");
  const cet6Count = document.getElementById("cet6-count");

  toggle.checked = settings.enabled;
  cet4Toggle.checked = settings.cet4Enabled;
  cet6Toggle.checked = settings.cet6Enabled;

  const totalWords = vocab.length +
    (settings.cet4Enabled ? CET4.length : 0) +
    (settings.cet6Enabled ? CET6.length : 0);
  if (wordCount) wordCount.textContent = String(totalWords);

  if (cet4Count) cet4Count.textContent = `(${CET4.length}词)`;
  if (cet6Count) cet6Count.textContent = `(${CET6.length}词)`;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

  async function updateMatchCount(): Promise<void> {
    if (tabs[0]?.id && matchCount) {
      try {
        const response = await chrome.tabs.sendMessage(tabs[0].id, { type: "get-match-count" });
        matchCount.textContent = String(response?.count ?? 0);
      } catch {
        matchCount.textContent = "—";
      }
    }
  }
  updateMatchCount();

  async function notifyContent(): Promise<void> {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "vocab-updated" }).catch(() => {});
    }
  }

  async function updateWordCount(): Promise<void> {
    const s = await getSettings();
    const v = await getVocabList();
    const total = v.length +
      (s.cet4Enabled ? CET4.length : 0) +
      (s.cet6Enabled ? CET6.length : 0);
    if (wordCount) wordCount.textContent = String(total);
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

  cet4Toggle.addEventListener("change", async () => {
    await updateSettings({ cet4Enabled: cet4Toggle.checked });
    await updateWordCount();
    await notifyContent();
  });

  cet6Toggle.addEventListener("change", async () => {
    await updateSettings({ cet6Enabled: cet6Toggle.checked });
    await updateWordCount();
    await notifyContent();
  });

  manageBtn?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
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
      await updateWordCount();
      await notifyContent();
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
    await new Promise<void>((resolve) => {
      const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      if (tab.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
    window.close();
  });
}

init();
