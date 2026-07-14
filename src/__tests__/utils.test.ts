import { describe, it, expect } from "vitest";
import { normalizeWord } from "../common/utils.js";

describe("normalizeWord", () => {
  it("lowercases the word", () => {
    expect(normalizeWord("Commit")).toBe("commit");
    expect(normalizeWord("DEPLOYING")).toBe("deploying");
  });

  it("trims whitespace", () => {
    expect(normalizeWord("  repository  ")).toBe("repository");
  });

  it("handles mixed casing and spaces", () => {
    expect(normalizeWord("  GitHub  ")).toBe("github");
  });
});
