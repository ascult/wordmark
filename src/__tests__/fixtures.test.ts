import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import { replaceMatches } from "../content/replacer.js";
import { AhoCorasick } from "../content/matcher.js";
import type { VocabInfo } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

function loadFixture(name: string): string {
  return fs.readFileSync(`src/__tests__/fixtures/${name}.md`, "utf8");
}

function createMatcher(patterns: Map<string, string[]>): AhoCorasick {
  return new AhoCorasick(patterns);
}

const reactMd = loadFixture("react");
const fccMd = loadFixture("freeCodeCamp");
const vscodeMd = loadFixture("vscode");
const bootstrapMd = loadFixture("bootstrap");

describe("AhoCorasick on real READMEs", () => {
  it("finds 'React' in React README", () => {
    const ac = new AhoCorasick(new Map([["react", ["react"]]]));
    const results = ac.search(reactMd.toLowerCase());
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.every((r) => r.word === "react")).toBe(true);
  });

  it("finds 'code' in freeCodeCamp README", () => {
    const ac = new AhoCorasick(new Map([["code", ["code"]]]));
    const results = ac.search(fccMd.toLowerCase());
    expect(results.length).toBeGreaterThanOrEqual(5);
  });

  it("finds 'build' in React README", () => {
    const ac = new AhoCorasick(new Map([["build", ["build", "builds", "building"]]]));
    const results = ac.search(reactMd.toLowerCase());
    expect(results.some((r) => r.word === "build")).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("finds common README words across all fixtures", () => {
    const patterns = new Map([
      ["install", ["install", "installs", "installed", "installing"]],
      ["run", ["run", "runs", "running"]],
      ["code", ["code"]],
      ["test", ["test", "tests", "testing"]],
    ]);
    const ac = new AhoCorasick(patterns);

    for (const [name, md] of Object.entries({ react: reactMd, fcc: fccMd, vscode: vscodeMd, bootstrap: bootstrapMd })) {
      const results = ac.search(md.toLowerCase());
      expect(results.length, `${name} should have matches`).toBeGreaterThan(0);
    }
  });

  it("does not produce false positives on punctuation-dense content", () => {
    const ac = new AhoCorasick(new Map([["javascript", ["javascript"]]]));
    const heading = "## freeCodeCamp.org's open-source codebase and curriculum";
    const results = ac.search(heading.toLowerCase());
    expect(results.length).toBe(0);
  });
});

describe("replaceMatches on real README content", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces matched words in React excerpt", () => {
    const excerpt = "React is a JavaScript library for building user interfaces. Build encapsulated components that manage their own state.";
    document.body.innerHTML = `<div>${excerpt}</div>`;

    const patterns = new Map([
      ["library", ["library"]],
      ["build", ["build", "builds", "building"]],
      ["component", ["component", "components"]],
    ]);
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
      ["build", { definition: "构建", source: "custom" }],
      ["component", { definition: "组件", source: "custom" }],
    ]);

    replaceMatches(document.body, new AhoCorasick(patterns), vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks.length).toBeGreaterThanOrEqual(3);

    const texts = Array.from(marks).map((m) => m.textContent);
    expect(texts.some((t) => t && t.includes("library(库)"))).toBe(true);
    expect(texts.some((t) => t && t.includes("Build(构建)"))).toBe(true);
    expect(texts.some((t) => t && t.includes("components(组件)"))).toBe(true);
  });

  it("processes visible text including pre-formatted blocks", () => {
    const html = '<div>install react</div><pre><code>npm install react</code></pre>';
    document.body.innerHTML = html;

    const patterns = new Map([["install", ["install"]]]);
    const vocabMap = new Map<string, VocabInfo>([
      ["install", { definition: "安装", source: "custom" }],
    ]);

    replaceMatches(document.body, new AhoCorasick(patterns), vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks.length).toBeGreaterThanOrEqual(1);
  });

  it("annotates words in inline code elements", () => {
    document.body.innerHTML = "<div>use <code>npm install</code> to install</div>";

    const patterns = new Map([["install", ["install"]]]);
    const vocabMap = new Map<string, VocabInfo>([
      ["install", { definition: "安装", source: "custom" }],
    ]);

    replaceMatches(document.body, new AhoCorasick(patterns), vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("page segments from real README text", () => {
  it("produces segments for each README fixture", () => {
    for (const md of [reactMd, fccMd, vscodeMd, bootstrapMd]) {
      const lines = md.split("\n").filter((l) => l.trim().length > 10);
      expect(lines.length).toBeGreaterThan(10);
    }
  });

  it("all fixtures contain substantial technical vocabulary", () => {
    const terms = ["install", "code", "build", "html", "css", "javascript", "node", "api", "github"];
    for (const md of [reactMd, fccMd, vscodeMd, bootstrapMd]) {
      const lower = md.toLowerCase();
      const found = terms.filter((t) => lower.includes(t));
      expect(found.length, `fixture should contain technical terms`).toBeGreaterThanOrEqual(3);
    }
  });

  it("all fixtures contain markdown links", () => {
    for (const md of [reactMd, fccMd, vscodeMd, bootstrapMd]) {
      expect(md).toMatch(/\[.*\]\(.*\)/);
    }
  });

  it("all fixtures contain markdown headings", () => {
    for (const md of [reactMd, fccMd, vscodeMd, bootstrapMd]) {
      expect(md).toMatch(/^#{1,3}\s/m);
    }
  });
});
