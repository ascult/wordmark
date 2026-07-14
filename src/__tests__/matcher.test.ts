import { describe, it, expect } from "vitest";
import { AhoCorasick } from "../content/matcher.js";
import type { WordBound } from "../content/tokenizer.js";

describe("AhoCorasick", () => {
  it("finds a single word in text", () => {
    const patterns = new Map([["library", ["library"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("a JavaScript library for building");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ word: "library", index: 13 });
  });

  it("finds multiple occurrences of the same word", () => {
    const patterns = new Map([["code", ["code"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("write code and review code");
    expect(results).toHaveLength(2);
  });

  it("finds multiple different words", () => {
    const patterns = new Map([
      ["build", ["build"]],
      ["state", ["state"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("build components that manage state");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.word)).toEqual(
      expect.arrayContaining(["build", "state"])
    );
  });

  it("matches word variants from inflection patterns", () => {
    const patterns = new Map([
      ["build", ["build", "builds", "building"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("build");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("build");
  });

  it("finds distinct variant words when separated by spaces", () => {
    const patterns = new Map([
      ["build", ["build", "builds", "building"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("build builds");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("does not match substrings (word boundary)", () => {
    const patterns = new Map([["pack", ["pack"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("webpack");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("pack");
  });

  it("handles empty text", () => {
    const patterns = new Map([["test", ["test"]]]);
    const ac = new AhoCorasick(patterns);
    expect(ac.search("")).toEqual([]);
  });

  it("handles text with no matches", () => {
    const patterns = new Map([["python", ["python"]]]);
    const ac = new AhoCorasick(patterns);
    expect(ac.search("javascript is great")).toEqual([]);
  });

  it("handles overlapping patterns correctly", () => {
    const patterns = new Map([
      ["react", ["react"]],
      ["react-native", ["react-native"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("use react-native");
    expect(results.some((r) => r.word === "react-native")).toBe(true);
  });

  it("reports correct match indices", () => {
    const patterns = new Map([["react", ["react"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("npm install react");
    expect(results[0]).toMatchObject({ word: "react", index: 12, endIndex: 17 });
  });

  it("matches at the start of text", () => {
    const patterns = new Map([["npm", ["npm"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("npm install react");
    expect(results[0].index).toBe(0);
  });

  it("matches at the end of text", () => {
    const patterns = new Map([["react", ["react"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("install react");
    expect(results[0].endIndex).toBe(13);
  });

  it("handles case sensitivity (lowercase only)", () => {
    const patterns = new Map([["react", ["react"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("REACT");
    expect(results).toHaveLength(0);
  });

  it("handles large number of patterns", () => {
    const patterns = new Map<string, string[]>();
    for (let i = 0; i < 100; i++) {
      patterns.set(`module${i}`, [`module${i}`]);
    }
    const ac = new AhoCorasick(patterns);
    const results = ac.search("module50 and module99");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.word)).toEqual(
      expect.arrayContaining(["module50", "module99"])
    );
  });

  it("filters out matches that don't start at word boundaries", () => {
    const patterns = new Map([["act", ["act"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [{ start: 0, end: 5 }];
    const results = ac.search("react", wordBounds);
    expect(results).toHaveLength(0);
  });

  it("keeps matches that align with word boundaries", () => {
    const patterns = new Map([["git", ["git"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ];
    const results = ac.search("use git", wordBounds);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ word: "git", index: 4, endIndex: 7 });
  });

  it("returns all matches when no wordBounds provided", () => {
    const patterns = new Map([["act", ["act"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("react");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("act");
  });

  it("filters substring matches correctly for single-letter patterns", () => {
    const patterns = new Map([["i", ["i"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [
      { start: 0, end: 2 },
    ];
    const results = ac.search("ui", wordBounds);
    expect(results).toHaveLength(0);
  });

  it("uses variant length for correct index calculation on inflected forms", () => {
    const patterns = new Map([["build", ["build", "builds", "building"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [{ start: 0, end: 8 }];
    const results = ac.search("building", wordBounds);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.endIndex === 8);
    expect(match).toBeDefined();
    expect(match!.index).toBe(0);
  });
});
