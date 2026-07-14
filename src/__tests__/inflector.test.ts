import { describe, it, expect } from "vitest";
import { generateInflections } from "../content/inflector.js";

describe("generateInflections", () => {
  it("includes the base word", () => {
    const result = generateInflections("commit");
    expect(result).toContain("commit");
  });

  it("generates plural -s form", () => {
    const result = generateInflections("commit");
    expect(result).toContain("commits");
  });

  it("generates -es for words ending in s, x, z", () => {
    expect(generateInflections("dismiss")).toContain("dismisses");
    expect(generateInflections("reflex")).toContain("reflexes");
    expect(generateInflections("buzz")).toContain("buzzes");
  });

  it("generates -es for words ending in ch, sh", () => {
    expect(generateInflections("patch")).toContain("patches");
    expect(generateInflections("push")).toContain("pushes");
  });

  it("generates -es for words ending in o", () => {
    expect(generateInflections("echo")).toContain("echoes");
  });

  it("generates -ies for words ending in consonant + y", () => {
    const result = generateInflections("modify");
    expect(result).toContain("modifies");
    expect(result).toContain("modified");
  });

  it("does NOT generate -ies for words ending in vowel + y", () => {
    const result = generateInflections("deploy");
    expect(result).not.toContain("deplaies");
    expect(result).toContain("deploys");
  });

  it("generates -ed past tense", () => {
    expect(generateInflections("review")).toContain("reviewed");
  });

  it("generates -d for words ending in e", () => {
    expect(generateInflections("release")).toContain("released");
  });

  it("generates -ing form", () => {
    expect(generateInflections("review")).toContain("reviewing");
  });

  it("doubles final consonant for short words", () => {
    const result = generateInflections("log");
    expect(result).toContain("logging");
    expect(result).toContain("logged");
  });

  it("does not double final consonant for long words", () => {
    const result = generateInflections("review");
    expect(result).toContain("reviewing");
    expect(result).not.toContain("reviewwing");
  });

  it("handles empty string", () => {
    const result = generateInflections("");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result).toContain("");
  });

  it("generates all expected forms for a regular verb", () => {
    const result = generateInflections("deploy");
    expect(result).toEqual(
      expect.arrayContaining(["deploy", "deploys", "deployed", "deploying"])
    );
  });

  it("generates all expected forms for a noun", () => {
    const result = generateInflections("release");
    expect(result).toEqual(
      expect.arrayContaining(["release", "releases"])
    );
    expect(result).toContain("released");
    expect(result).toContain("releaseing");
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
