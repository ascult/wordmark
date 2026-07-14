import { describe, it, expect } from "vitest";
import { normalizeWord } from "../common/utils.js";

describe("normalizeWord", () => {
  it("lowercases the word", () => {
    expect(normalizeWord("Look")).toBe("look");
    expect(normalizeWord("LOOKING")).toBe("looking");
  });

  it("trims whitespace", () => {
    expect(normalizeWord("  hello  ")).toBe("hello");
  });

  it("handles mixed casing and spaces", () => {
    expect(normalizeWord("  Apple  ")).toBe("apple");
  });
});
