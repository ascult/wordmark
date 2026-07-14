import { describe, it, expect } from "vitest";
import { generateInflections } from "../content/inflector.js";

describe("generateInflections", () => {
  it("includes the base word", () => {
    const result = generateInflections("look");
    expect(result).toContain("look");
  });

  it("generates plural -s form", () => {
    const result = generateInflections("look");
    expect(result).toContain("looks");
  });

  it("generates -es for words ending in s, x, z", () => {
    expect(generateInflections("pass")).toContain("passes");
    expect(generateInflections("box")).toContain("boxes");
    expect(generateInflections("buzz")).toContain("buzzes");
  });

  it("generates -es for words ending in ch, sh", () => {
    expect(generateInflections("watch")).toContain("watches");
    expect(generateInflections("push")).toContain("pushes");
  });

  it("generates -es for words ending in o", () => {
    expect(generateInflections("go")).toContain("goes");
  });

  it("generates -ies for words ending in consonant + y", () => {
    const result = generateInflections("study");
    expect(result).toContain("studies");
    expect(result).toContain("studied");
  });

  it("does NOT generate -ies for words ending in vowel + y", () => {
    const result = generateInflections("play");
    expect(result).not.toContain("plaies");
    expect(result).toContain("plays");
  });

  it("generates -ed past tense", () => {
    expect(generateInflections("look")).toContain("looked");
  });

  it("generates -d for words ending in e", () => {
    expect(generateInflections("like")).toContain("liked");
  });

  it("generates -ing form", () => {
    expect(generateInflections("look")).toContain("looking");
  });

  it("doubles final consonant for short words", () => {
    const result = generateInflections("run");
    expect(result).toContain("running");
    expect(result).toContain("runned");
  });

  it("does not double final consonant for long words", () => {
    const result = generateInflections("develop");
    expect(result).toContain("developing");
    expect(result).not.toContain("developping");
  });

  it("handles empty string", () => {
    const result = generateInflections("");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result).toContain("");
  });

  it("generates all expected forms for a regular verb", () => {
    const result = generateInflections("walk");
    expect(result).toEqual(
      expect.arrayContaining(["walk", "walks", "walked", "walking"])
    );
  });

  it("generates all expected forms for a noun", () => {
    const result = generateInflections("apple");
    expect(result).toEqual(
      expect.arrayContaining(["apple", "apples"])
    );
    expect(result).toContain("appled");
    expect(result).toContain("appleing");
  });

  it("generates -ly adverb form", () => {
    const result = generateInflections("independent");
    expect(result).toContain("independently");
  });

  it("generates -ly by dropping final e", () => {
    const result = generateInflections("simple");
    expect(result).toContain("simply");
  });
});
