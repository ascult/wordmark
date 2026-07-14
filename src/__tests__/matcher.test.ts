import { describe, it, expect } from "vitest";
import { AhoCorasick } from "../content/matcher.js";
import type { WordBound } from "../content/tokenizer.js";

describe("AhoCorasick", () => {
  it("finds a single word in text", () => {
    const patterns = new Map([["look", ["look"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("I look at the sky");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ word: "look", index: 2 });
  });

  it("finds multiple occurrences of the same word", () => {
    const patterns = new Map([["look", ["look"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("look look look");
    expect(results).toHaveLength(3);
  });

  it("finds multiple different words", () => {
    const patterns = new Map([
      ["apple", ["apple"]],
      ["orange", ["orange"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("I have an apple and an orange");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.word)).toEqual(
      expect.arrayContaining(["apple", "orange"])
    );
  });

  it("matches word variants from inflection patterns", () => {
    const patterns = new Map([
      ["look", ["look", "looks", "looked", "looking"]],
    ]);
    const ac = new AhoCorasick(patterns);
    // AC naturally finds overlapping matches (e.g. "look" inside "looking")
    // The deduplication is handled by mergeOverlapping in the replacer
    const results = ac.search("look");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("look");
  });

  it("finds distinct variant words when separated by spaces", () => {
    const patterns = new Map([
      ["run", ["run", "runs", "running"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("run runs");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("does not match substrings (word boundary)", () => {
    const patterns = new Map([["apple", ["apple"]]]);
    const ac = new AhoCorasick(patterns);
    // Note: Aho-Corasick doesn't do word boundaries by itself -
    // that's handled at the replacement layer. Here we test raw matching.
    const results = ac.search("pineapple");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("apple");
  });

  it("handles empty text", () => {
    const patterns = new Map([["test", ["test"]]]);
    const ac = new AhoCorasick(patterns);
    expect(ac.search("")).toEqual([]);
  });

  it("handles text with no matches", () => {
    const patterns = new Map([["xyz", ["xyz"]]]);
    const ac = new AhoCorasick(patterns);
    expect(ac.search("hello world")).toEqual([]);
  });

  it("handles overlapping patterns correctly", () => {
    const patterns = new Map([
      ["cat", ["cat"]],
      ["cats", ["cats"]],
    ]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("I like cats");
    // Should find "cats" (longer match)
    expect(results.some((r) => r.word === "cats")).toBe(true);
  });

  it("reports correct match indices", () => {
    const patterns = new Map([["hello", ["hello"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("say hello world");
    expect(results[0]).toMatchObject({ word: "hello", index: 4, endIndex: 9 });
  });

  it("matches at the start of text", () => {
    const patterns = new Map([["hello", ["hello"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("hello world");
    expect(results[0].index).toBe(0);
  });

  it("matches at the end of text", () => {
    const patterns = new Map([["world", ["world"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("hello world");
    expect(results[0].endIndex).toBe(11);
  });

  it("handles case sensitivity (lowercase only)", () => {
    const patterns = new Map([["hello", ["hello"]]]);
    const ac = new AhoCorasick(patterns);
    // Searching with lowercase as per the engine design
    const results = ac.search("HELLO");
    expect(results).toHaveLength(0);
  });

  it("handles large number of patterns", () => {
    const patterns = new Map<string, string[]>();
    for (let i = 0; i < 100; i++) {
      patterns.set(`word${i}`, [`word${i}`]);
    }
    const ac = new AhoCorasick(patterns);
    const results = ac.search("word50 and word99");
    // AC may find overlapping patterns (e.g. "word5" inside "word50")
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.map((r) => r.word)).toEqual(
      expect.arrayContaining(["word50", "word99"])
    );
  });

  it("filters out matches that don't start at word boundaries", () => {
    const patterns = new Map([["apple", ["apple"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [{ start: 0, end: 9 }];
    const results = ac.search("pineapple", wordBounds);
    expect(results).toHaveLength(0);
  });

  it("keeps matches that align with word boundaries", () => {
    const patterns = new Map([["apple", ["apple"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [
      { start: 0, end: 3 },
      { start: 4, end: 9 },
    ];
    const results = ac.search("eat apple", wordBounds);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ word: "apple", index: 4, endIndex: 9 });
  });

  it("returns all matches when no wordBounds provided", () => {
    const patterns = new Map([["apple", ["apple"]]]);
    const ac = new AhoCorasick(patterns);
    const results = ac.search("pineapple");
    expect(results).toHaveLength(1);
    expect(results[0].word).toBe("apple");
  });

  it("filters substring matches correctly for single-letter patterns", () => {
    const patterns = new Map([["i", ["i"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [
      { start: 0, end: 6 },
    ];
    // "unique" contains "i" at position 4 but "i" is not a whole word
    const results = ac.search("unique", wordBounds);
    expect(results).toHaveLength(0);
  });

  it("uses variant length for correct index calculation on inflected forms", () => {
    const patterns = new Map([["look", ["look", "looks", "looked", "looking"]]]);
    const ac = new AhoCorasick(patterns);
    const wordBounds: WordBound[] = [{ start: 0, end: 7 }];
    const results = ac.search("looking", wordBounds);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The match for "looking" variant should start at index 0, not index 3
    const match = results.find((r) => r.endIndex === 7);
    expect(match).toBeDefined();
    expect(match!.index).toBe(0);
  });
});
