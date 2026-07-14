import { describe, it, expect, beforeEach } from "vitest";
import { replaceMatches } from "../content/replacer.js";
import { AhoCorasick } from "../content/matcher.js";
import type { VocabInfo } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

const mockVocabMap = new Map<string, VocabInfo>([
  ["project", { definition: "项目", source: "custom" }],
  ["features", { definition: "特点", source: "custom" }],
]);

function createMatcher(patterns: Map<string, string[]>): AhoCorasick {
  return new AhoCorasick(patterns);
}

describe("replaceMatches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces matched words in text content", () => {
    document.body.innerHTML = "<div>project features</div>";
    const matcher = createMatcher(new Map([
      ["project", ["project"]],
      ["features", ["features"]],
    ]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("project(项目)");
    expect(marks[1].textContent).toBe("features(特点)");
  });

  it("does not modify text with no matches", () => {
    document.body.innerHTML = "<div>A library for building user interfaces</div>";
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    expect(document.body.innerHTML).toContain("building user interfaces");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`)).toHaveLength(0);
  });

  it("preserves non-matching text around matches", () => {
    document.body.innerHTML = "<div>clone the project repository</div>";
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const html = document.body.innerHTML;
    expect(html).toContain("project(项目)");
  });

  it("skips script tags", () => {
    document.body.innerHTML = '<script>const project = { name: "wordmark" };</script><div>open source project</div>';
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const scriptContent = document.querySelector("script")?.textContent;
    expect(scriptContent).toBe('const project = { name: "wordmark" };');
  });

  it("skips style tags", () => {
    document.body.innerHTML = '<style>.project { color: #0969da; }</style><div>new project</div>';
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const styleContent = document.querySelector("style")?.textContent;
    expect(styleContent).toBe(".project { color: #0969da; }");
  });

  it("skips textarea elements", () => {
    document.body.innerHTML = '<textarea>project name</textarea><div>new project</div>';
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const textarea = document.querySelector("textarea");
    expect(textarea?.value).toBe("project name");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`).length).toBeGreaterThan(0);
  });

  it("handles multiple matches in a single text node", () => {
    document.body.innerHTML = "<div>project project project</div>";
    const matcher = createMatcher(new Map([["project", ["project"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(3);
  });

  it("replaces matching word variants (inflections)", () => {
    document.body.innerHTML = "<div>install dependencies</div>";
    const matcher = createMatcher(new Map([["install", ["install", "installs", "installed", "installing"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["install", { definition: "安装", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("install(安装)");
    expect(marks[0].getAttribute("data-original")).toBe("install");
  });

  it("creates mark elements with correct styling", () => {
    document.body.innerHTML = "<div>install</div>";
    const matcher = createMatcher(new Map([["install", ["install"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["install", { definition: "安装", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const mark = document.querySelector("mark") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.className).toBe(ANNOTATION_CLASS);
    expect(mark.style.backgroundColor).toBe("rgb(255, 243, 205)");
  });

  it("handles empty vocab list", () => {
    document.body.innerHTML = "<div>npm install</div>";
    const matcher = createMatcher(new Map());
    replaceMatches(document.body, matcher, new Map());
    expect(document.body.innerHTML).toContain("npm install");
  });

  it("preserves original text as data attribute", () => {
    document.body.innerHTML = "<div>project features</div>";
    const matcher = createMatcher(new Map([
      ["project", ["project"]],
      ["features", ["features"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["project", { definition: "项目", source: "custom" }],
      ["features", { definition: "特点", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks[0].getAttribute("data-original")).toBe("project");
    expect(marks[1].getAttribute("data-original")).toBe("features");
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
    replaceMatches(document.body, matcher, mockVocabMap);
    expect(document.body.innerHTML).toContain("!!!");
  });
});
