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
      vocabList: [{ id: "1", word: "repository", definition: "仓库", createdAt: 100 }],
      settings: { enabled: true, whitelist: [], blacklist: [], importSampleDone: true },
    });
    const data = await getStorageData();
    expect(data.vocabList).toHaveLength(1);
    expect(data.vocabList[0].word).toBe("repository");
    expect(data.settings.enabled).toBe(true);
  });
});

describe("addWord", () => {
  it("adds a word and returns the entry", async () => {
    const entry = await addWord("Repository", "仓库");
    expect(entry.word).toBe("repository");
    expect(entry.definition).toBe("仓库");
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeGreaterThan(0);
    const list = await getVocabList();
    expect(list).toHaveLength(1);
  });

  it("appends to existing list", async () => {
    await addWord("branch", "分支");
    await addWord("merge", "合并");
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("deduplicates by normalized word", async () => {
    await addWord("Branch", "分支");
    await addWord("branch", "分叉");
    const list = await getVocabList();
    expect(list).toHaveLength(1);
    expect(list[0].definition).toBe("分叉");
  });
});

describe("removeWord", () => {
  it("removes a word by id", async () => {
    const entry = await addWord("branch", "分支");
    await removeWord(entry.id);
    const list = await getVocabList();
    expect(list).toHaveLength(0);
  });

  it("does nothing if id does not exist", async () => {
    await addWord("branch", "分支");
    await removeWord("nonexistent");
    const list = await getVocabList();
    expect(list).toHaveLength(1);
  });
});

describe("updateWord", () => {
  it("updates a word entry", async () => {
    const entry = await addWord("commit", "提交");
    await updateWord(entry.id, { definition: "git 提交" });
    const list = await getVocabList();
    expect(list[0].definition).toBe("git 提交");
    expect(list[0].word).toBe("commit");
  });

  it("does nothing if id does not exist", async () => {
    await addWord("commit", "提交");
    await updateWord("nonexistent", { definition: "changed" });
    const list = await getVocabList();
    expect(list).toHaveLength(1);
    expect(list[0].definition).toBe("提交");
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
    await updateSettings({ whitelist: ["github.com"] });
    const settings = await getSettings();
    expect(settings.whitelist).toEqual(["github.com"]);
  });
});

describe("importJSON", () => {
  it("imports words from JSON string", async () => {
    const json = JSON.stringify([
      { word: "repo", definition: "仓库" },
      { word: "pr", definition: "合并请求" },
    ]);
    const count = await importJSON(json);
    expect(count).toBe(2);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("deduplicates imported words against existing", async () => {
    await addWord("repo", "仓库");
    const json = JSON.stringify([
      { word: "repo", definition: "远程仓库" },
      { word: "pr", definition: "合并请求" },
    ]);
    await importJSON(json);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.word === "repo")?.definition).toBe("远程仓库");
  });
});

describe("exportJSON", () => {
  it("exports vocab list as JSON string", async () => {
    await addWord("deploy", "部署");
    const list = await getVocabList();
    const json = exportJSON(list);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual([{ word: "deploy", definition: "部署" }]);
  });

  it("returns empty array JSON for empty list", async () => {
    const json = exportJSON([]);
    expect(JSON.parse(json)).toEqual([]);
  });
});

describe("importCSV", () => {
  it("imports words from CSV string", async () => {
    const csv = "word,definition\nclone,克隆\nfork,分叉";
    const count = await importCSV(csv);
    expect(count).toBe(2);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });

  it("handles CSV with quoted definitions", async () => {
    const csv = 'clone,"克隆,复制仓库"\nfork,分叉';
    await importCSV(csv);
    const list = await getVocabList();
    expect(list.find((e) => e.word === "clone")?.definition).toBe("\"克隆,复制仓库\"");
  });

  it("skips empty lines", async () => {
    const csv = "clone,克隆\n\nfork,分叉\n";
    await importCSV(csv);
    const list = await getVocabList();
    expect(list).toHaveLength(2);
  });
});

describe("exportCSV", () => {
  it("exports vocab list as CSV string", async () => {
    await addWord("deploy", "部署");
    const list = await getVocabList();
    const csv = exportCSV(list);
    expect(csv).toContain("deploy");
    expect(csv).toContain("部署");
    expect(csv).toContain("word,definition");
  });
});
