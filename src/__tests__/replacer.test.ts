import { describe, it, expect, beforeEach } from "vitest";
import { replaceMatches } from "../content/replacer.js";
import { AhoCorasick } from "../content/matcher.js";
import type { VocabInfo } from "../common/types.js";
import { ANNOTATION_CLASS } from "../common/constants.js";

const mockVocabMap = new Map<string, VocabInfo>([
  ["hello", { definition: "你好", source: "custom" }],
  ["world", { definition: "世界", source: "custom" }],
]);

function createMatcher(patterns: Map<string, string[]>): AhoCorasick {
  return new AhoCorasick(patterns);
}

function stripAnnotations(html: string): string {
  // Replace <mark class="wm-annotated" ...>text</mark> with just text
  return html.replace(/<mark[^>]*data-original="([^"]*)"[^>]*>.*?<\/mark>/g, "$1");
}

describe("replaceMatches", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("replaces matched words in text content", () => {
    document.body.innerHTML = "<div>hello world</div>";
    const matcher = createMatcher(new Map([
      ["hello", ["hello"]],
      ["world", ["world"]],
    ]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("hello(你好)");
    expect(marks[1].textContent).toBe("world(世界)");
  });

  it("does not modify text with no matches", () => {
    document.body.innerHTML = "<div>foo bar baz</div>";
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    expect(document.body.innerHTML).toContain("foo bar baz");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`)).toHaveLength(0);
  });

  it("preserves non-matching text around matches", () => {
    document.body.innerHTML = "<div>say hello to me</div>";
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const html = document.body.innerHTML;
    expect(html).toContain("hello(你好)");
  });

  it("skips script tags", () => {
    document.body.innerHTML = '<script>var hello = "test";</script><div>hello world</div>';
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    // The script content should be untouched
    const scriptContent = document.querySelector("script")?.textContent;
    expect(scriptContent).toBe('var hello = "test";');
  });

  it("skips style tags", () => {
    document.body.innerHTML = '<style>.hello { color: red; }</style><div>hello world</div>';
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const styleContent = document.querySelector("style")?.textContent;
    expect(styleContent).toBe(".hello { color: red; }");
  });

  it("skips textarea elements", () => {
    document.body.innerHTML = '<textarea>hello</textarea><div>hello world</div>';
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const textarea = document.querySelector("textarea");
    expect(textarea?.value).toBe("hello");
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`).length).toBeGreaterThan(0);
  });

  it("handles multiple matches in a single text node", () => {
    document.body.innerHTML = "<div>hello hello hello</div>";
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(3);
  });

  it("replaces matching word variants (inflections)", () => {
    document.body.innerHTML = "<div>look forward</div>";
    const matcher = createMatcher(new Map([["look", ["look", "looks", "looked", "looking"]]]));
    const vocabMap = new Map<string, VocabInfo>([
      ["look", { definition: "看", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("look(看)");
    expect(marks[0].getAttribute("data-original")).toBe("look");
  });

  it("creates mark elements with correct styling", () => {
    document.body.innerHTML = "<div>hello</div>";
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);

    const mark = document.querySelector("mark") as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.className).toBe(ANNOTATION_CLASS);
    expect(mark.style.backgroundColor).toBe("rgb(255, 243, 205)");
  });

  it("handles empty vocab list", () => {
    document.body.innerHTML = "<div>hello world</div>";
    const matcher = createMatcher(new Map());
    replaceMatches(document.body, matcher, new Map());
    expect(document.body.innerHTML).toContain("hello world");
  });

  it("preserves original text as data attribute", () => {
    document.body.innerHTML = "<div>hello world</div>";
    const matcher = createMatcher(new Map([
      ["hello", ["hello"]],
      ["world", ["world"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["hello", { definition: "你好", source: "custom" }],
      ["world", { definition: "世界", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks[0].getAttribute("data-original")).toBe("hello");
    expect(marks[1].getAttribute("data-original")).toBe("world");
  });

  it("does not match substrings inside words", () => {
    document.body.innerHTML = "<div>pineapple</div>";
    const matcher = createMatcher(new Map([["apple", ["apple"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);
    expect(document.querySelectorAll(`.${ANNOTATION_CLASS}`)).toHaveLength(0);
    expect(document.body.innerHTML).toContain("pineapple");
  });

  it("does not annotate common stop words", () => {
    document.body.innerHTML = "<div>the apple is red</div>";
    const matcher = createMatcher(new Map([
      ["the", ["the"]],
      ["apple", ["apple"]],
      ["is", ["is"]],
      ["red", ["red"]],
    ]));
    const vocabMap = new Map<string, VocabInfo>([
      ["the", { definition: "定冠词", source: "custom" }],
      ["apple", { definition: "苹果", source: "custom" }],
      ["is", { definition: "是", source: "custom" }],
      ["red", { definition: "红色的", source: "custom" }],
    ]);
    replaceMatches(document.body, matcher, vocabMap);

    const marks = document.querySelectorAll(`.${ANNOTATION_CLASS}`);
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("apple(苹果)");
    expect(marks[1].textContent).toBe("red(红色的)");
  });

  it("handles text with no word-like segments gracefully", () => {
    document.body.innerHTML = "<div>!!!</div>";
    const matcher = createMatcher(new Map([["hello", ["hello"]]]));
    replaceMatches(document.body, matcher, mockVocabMap);
    expect(document.body.innerHTML).toContain("!!!");
  });
});
