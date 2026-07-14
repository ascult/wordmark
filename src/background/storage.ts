import type { VocabularyEntry, Settings, StorageData } from "../common/types.js";
import { STORAGE_KEYS, DEFAULT_SETTINGS } from "../common/constants.js";
import { generateId, normalizeWord } from "../common/utils.js";

export async function getStorageData(): Promise<StorageData> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.VOCAB_LIST,
    STORAGE_KEYS.SETTINGS,
  ]);
  return {
    vocabList: result.vocabList ?? [],
    settings: result.settings ?? { ...DEFAULT_SETTINGS },
  };
}

export async function getVocabList(): Promise<VocabularyEntry[]> {
  const data = await getStorageData();
  return data.vocabList;
}

export async function addWord(
  word: string,
  definition: string
): Promise<VocabularyEntry> {
  const data = await getStorageData();
  const normalized = normalizeWord(word);
  const existing = data.vocabList.find((e) => e.word === normalized);
  if (existing) {
    existing.definition = definition;
    await chrome.storage.local.set({ vocabList: data.vocabList });
    return existing;
  }
  const entry: VocabularyEntry = {
    id: generateId(),
    word: normalized,
    definition,
    createdAt: Date.now(),
  };
  data.vocabList.push(entry);
  await chrome.storage.local.set({ vocabList: data.vocabList });
  return entry;
}

export async function removeWord(id: string): Promise<void> {
  const data = await getStorageData();
  data.vocabList = data.vocabList.filter((e) => e.id !== id);
  await chrome.storage.local.set({ vocabList: data.vocabList });
}

export async function updateWord(
  id: string,
  updates: Partial<VocabularyEntry>
): Promise<void> {
  const data = await getStorageData();
  data.vocabList = data.vocabList.map((e) =>
    e.id === id ? { ...e, ...updates } : e
  );
  await chrome.storage.local.set({ vocabList: data.vocabList });
}

export async function getSettings(): Promise<Settings> {
  const data = await getStorageData();
  return data.settings;
}

export async function updateSettings(
  updates: Partial<Settings>
): Promise<void> {
  const data = await getStorageData();
  data.settings = { ...data.settings, ...updates };
  await chrome.storage.local.set({ settings: data.settings });
}

export async function importJSON(json: string): Promise<number> {
  const entries: Omit<VocabularyEntry, "id" | "createdAt">[] = JSON.parse(json);
  const data = await getStorageData();
  let count = 0;
  for (const entry of entries) {
    const normalized = normalizeWord(entry.word);
    if (!normalized) continue;
    const existing = data.vocabList.find((e) => e.word === normalized);
    if (existing) {
      existing.definition = entry.definition;
    } else {
      data.vocabList.push({
        id: generateId(),
        word: normalized,
        definition: entry.definition,
        createdAt: Date.now(),
      });
    }
    count++;
  }
  await chrome.storage.local.set({ vocabList: data.vocabList });
  return count;
}

export function exportJSON(vocabList: VocabularyEntry[]): string {
  return JSON.stringify(
    vocabList.map((e) => ({ word: e.word, definition: e.definition })),
    null,
    2
  );
}

export async function importCSV(csv: string): Promise<number> {
  const lines = csv.split("\n").filter((l) => l.trim());
  const entries: Omit<VocabularyEntry, "id" | "createdAt">[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && /^word[,;\t]/i.test(lines[i])) continue;
    const parts = lines[i].split(",");
    if (parts.length < 2) continue;
    const word = parts[0].trim();
    const definition = parts.slice(1).join(",").trim();
    if (!word) continue;
    entries.push({ word, definition });
  }
  return importJSON(JSON.stringify(entries));
}

export function exportCSV(vocabList: VocabularyEntry[]): string {
  const header = "word,definition";
  const rows = vocabList.map(
    (e) => `${e.word},"${e.definition.replace(/"/g, '""')}"`
  );
  return [header, ...rows].join("\n");
}

export async function importSampleVocab(): Promise<number> {
  const { SAMPLE_VOCAB } = await import("../common/sample-vocab.js");
  return importJSON(JSON.stringify(SAMPLE_VOCAB));
}
