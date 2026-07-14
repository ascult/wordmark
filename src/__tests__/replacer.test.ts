import { describe, it, expect, beforeEach } from "vitest";
import { replaceMatches } from "../content/replacer.js";
import { AhoCorasick } from "../content/matcher.js";
import type { VocabInfo } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

function createMatcher(patterns: Map<string, string[]>): AhoCorasick {
  return new AhoCorasick(patterns);
}

describe("replaceMatches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces matched words in text content", () => {
    document.body.innerHTML = "<div>a library for building user interfaces</div>";
    const matcher = createMatcher(new Map([
      ["library", ["library"]],
      ["building", ["building"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
      ["building", { definition: "构建", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("library(库)");
    expect(marks[1].textContent).toBe("building(构建)");
  });

  it("does not modify text with no matches", () => {
    document.body.innerHTML = "<div>A declarative library for building interactive UIs</div>";
    const matcher = createMatcher(new Map([["framework", ["framework"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["framework", { definition: "框架", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    expect(document.body.innerHTML).toContain("declarative library");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`)).toHaveLength(0);
  });

  it("preserves non-matching text around matches", () => {
    document.body.innerHTML = "<div>you can use as little or as much React as you need</div>";
    const matcher = createMatcher(new Map([["need", ["need"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["need", { definition: "需要", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const html = document.body.innerHTML;
    expect(html).toContain("need(需要)");
  });

  it("skips script tags", () => {
    document.body.innerHTML = '<script>const library = "react";</script><div>JavaScript library</div>';
    const matcher = createMatcher(new Map([["library", ["library"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const scriptContent = document.querySelector("script")?.textContent;
    expect(scriptContent).toBe('const library = "react";');
  });

  it("skips style tags", () => {
    document.body.innerHTML = '<style>.library { color: #0969da; }</style><div>the library</div>';
    const matcher = createMatcher(new Map([["library", ["library"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const styleContent = document.querySelector("style")?.textContent;
    expect(styleContent).toBe(".library { color: #0969da; }");
  });

  it("skips textarea elements", () => {
    document.body.innerHTML = '<textarea>library component</textarea><div>a library</div>';
    const matcher = createMatcher(new Map([["library", ["library"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const textarea = document.querySelector("textarea");
    expect(textarea?.value).toBe("library component");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`).length).toBeGreaterThan(0);
  });

  it("handles multiple matches in a single text node", () => {
    document.body.innerHTML = "<div>component component component</div>";
    const matcher = createMatcher(new Map([["component", ["component"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["component", { definition: "组件", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(3);
  });

  it("replaces matching word variants (inflections)", () => {
    document.body.innerHTML = "<div>building components</div>";
    const matcher = createMatcher(new Map([["build", ["build", "builds", "building"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["build", { definition: "构建", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("building(构建)");
    expect(marks[0].getAttribute("data-original")).toBe("building");
  });

  it("creates mark elements with correct styling", () => {
    document.body.innerHTML = "<div>build</div>";
    const matcher = createMatcher(new Map([["build", ["build"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["build", { definition: "构建", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const mark = document.querySelector("mark") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.className).toBe(ANNOTATION_CLASS);
    expect(mark.style.backgroundColor).toBe("rgb(255, 243, 205)");
  });

  it("handles empty vocab list", () => {
    document.body.innerHTML = "<div>npm install react</div>";
    const matcher = createMatcher(new Map());
    replaceMatches(document.body, matcher, new Map());
    expect(document.body.innerHTML).toContain("npm install react");
  });

  it("preserves original text as data attribute", () => {
    document.body.innerHTML = "<div>library build</div>";
    const matcher = createMatcher(new Map([
      ["library", ["library"]],
      ["build", ["build"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["library", { definition: "库", source: "custom" }],
      ["build", { definition: "构建", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks[0].getAttribute("data-original")).toBe("library");
    expect(marks[1].getAttribute("data-original")).toBe("build");
  });

  it("does not match substrings inside words", () => {
    document.body.innerHTML = "<div>webpack</div>";
    const matcher = createMatcher(new Map([["pack", ["pack"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["pack", { definition: "包", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`)).toHaveLength(0);
    expect(document.body.innerHTML).toContain("webpack");
  });

  it("does not annotate common stop words", () => {
    document.body.innerHTML = "<div>the config is new</div>";
    const matcher = createMatcher(new Map([
      ["the", ["the"]],
      ["config", ["config"]],
      ["is", ["is"]],
      ["new", ["new"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["the", { definition: "定冠词", source: "custom" }],
      ["config", { definition: "配置", source: "custom" }],
      ["is", { definition: "是", source: "custom" }],
      ["new", { definition: "新的", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("config(配置)");
  });

  it("handles text with no word-like segments gracefully", () => {
    document.body.innerHTML = "<div>!!!</div>";
    const matcher = createMatcher(new Map([["test", ["test"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["test", { definition: "测试", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);
    expect(document.body.innerHTML).toContain("!!!");
  });
});
