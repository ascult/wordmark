import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getStorageData,
  getVocabList,
  addWord,
  removeWord,
  updateWord,
  getSettings,
  updateSettings,
  importJSON,
  exportJSON,
  importCSV,
  exportCSV,
} from "../background/storage.js";
import { resetMockStorage, setMockStorage } from "./setup.js";

beforeEach(() => {
  resetMockStorage();
  vi.clearAllMocks();
});

describe("getStorageData", () => {
  it("returns empty vocabList and default settings when storage is empty", async () => {
    const data = await getStorageData();
    expect(data).toEqual({
      vocabList: [],
      settings: { enabled: false, whitelist: [], blacklist: [], importSampleDone: false, cet4Enabled: false, cet6Enabled: false },
    });
  });

  it("returns stored data when present", async () => {
    setMockStorage({
      vocabList: [{ id: "1", word: "hello", definition: "你好", createdAt: 100 }],
      settings: { enabled: true, whitelist: [], blacklist: [], importSampleDone: true },
    });
    const data = await getStorageData();
    expect(data.vocabList).toHaveLength(1);
    expect(data.vocabList[0].word).toBe("hello");
    expect(data.settings.enabled).toBe(true);
  });
});

describe("addWord", () => {
  it("adds a word and returns the entry", async () => {
    const entry = await addWord("Hello", "你好");
    expect(entry.word).toBe("hello");
    expect(entry.definition).toBe("你好");
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeGreaterThan(0);
    const list = await getVocabList();
    expect(list).toHaveLength(1);
  });

  it("appends to existing list", async () => {
    await addWord("hello", "你好");
    await addWord("world", "世界");
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("deduplicates by normalized word", async () => {
    await addWord("Hello", "你好");
    await addWord("hello", "哈喽");
    const list = await getVocabList();
    expect(list).toHaveLength(1);
    expect(list[0].definition).toBe("哈喽");
  });
});

describe("removeWord", () => {
  it("removes a word by id", async () => {
    const entry = await addWord("hello", "你好");
    await removeWord(entry.id);
    const list = await getVocabList();
    expect(list).toHaveLength(0);
  });

  it("does nothing if id does not exist", async () => {
    await addWord("hello", "你好");
    await removeWord("nonexistent");
    const list = await getVocabList();
    expect(list).toHaveLength(1);
  });
});

describe("updateWord", () => {
  it("updates a word entry", async () => {
    const entry = await addWord("hello", "你好");
    await updateWord(entry.id, { definition: "哈喽" });
    const list = await getVocabList();
    expect(list[0].definition).toBe("哈喽");
    expect(list[0].word).toBe("hello");
  });

  it("does nothing if id does not exist", async () => {
    await addWord("hello", "你好");
    await updateWord("nonexistent", { definition: "changed" });
    const list = await getVocabList();
    expect(list).toHaveLength(1);
    expect(list[0].definition).toBe("你好");
  });
});

describe("settings", () => {
  it("returns default settings initially", async () => {
    const settings = await getSettings();
    expect(settings.enabled).toBe(false);
  });

  it("updates settings partially", async () => {
    await updateSettings({ enabled: true });
    const settings = await getSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.whitelist).toEqual([]);
  });

  it("updates whitelist", async () => {
    await updateSettings({ whitelist: ["example.com"] });
    const settings = await getSettings();
    expect(settings.whitelist).toEqual(["example.com"]);
  });
});

describe("importJSON", () => {
  it("imports words from JSON string", async () => {
    const json = JSON.stringify([
      { word: "hello", definition: "你好" },
      { word: "world", definition: "世界" },
    ]);
    const count = await importJSON(json);
    expect(count).toBe(2);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("deduplicates imported words against existing", async () => {
    await addWord("hello", "你好");
    const json = JSON.stringify([
      { word: "hello", definition: "哈喽" },
      { word: "world", definition: "世界" },
    ]);
    await importJSON(json);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.word === "hello")?.definition).toBe("哈喽");
  });
});

describe("exportJSON", () => {
  it("exports vocab list as JSON string", async () => {
    await addWord("hello", "你好");
    const list = await getVocabList();
    const json = exportJSON(list);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ word: "hello", definition: "你好" }]);
  });

  it("returns empty array JSON for empty list", async () => {
    const json = exportJSON([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

describe("importCSV", () => {
  it("imports words from CSV string", async () => {
    const csv = "word,definition\nhello,你好\nworld,世界";
    const count = await importCSV(csv);
    expect(count).toBe(2);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("handles CSV with quoted definitions", async () => {
    const csv = 'hello,"你好,朋友"\nworld,世界';
    await importCSV(csv);
    const list = await getVocabList();
    expect(list.find((e) => e.word === "hello")?.definition).toBe("\"你好,朋友\"");
  });

  it("skips empty lines", async () => {
    const csv = "hello,你好\n\nworld,世界\n";
    await importCSV(csv);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });
});

describe("exportCSV", () => {
  it("exports vocab list as CSV string", async () => {
    await addWord("hello", "你好");
    const list = await getVocabList();
    const csv = exportCSV(list);
    expect(csv).toContain("hello");
    expect(csv).toContain("你好");
    expect(csv).toContain("word,definition");
  });
});
