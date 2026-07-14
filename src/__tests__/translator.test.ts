import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLookup } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
}));

vi.mock("../common/dict.js", () => ({
  lookup: mockLookup,
  BUNDLED_DICT: {},
}));

const { mockBingTranslate } = vi.hoisted(() => ({
  mockBingTranslate: vi.fn(),
}));

vi.mock("../background/bing.js", () => ({
  bingTranslate: mockBingTranslate,
}));

import { translate, batchTranslate } from "../background/translator.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("translate (individual word lookup)", () => {
  it("returns definition from bundled dict", async () => {
    mockLookup.mockReturnValueOnce({ def: "n. 需要；必需；必要之物", cn: ["需要", "必需"] });
    const result = await translate("need");
    expect(result).toBe("n. 需要；必需；必要之物");
  });

  it("returns empty string for unknown word", async () => {
    mockLookup.mockReturnValueOnce(undefined);
    const result = await translate("xyzzy");
    expect(result).toBe("");
  });
});

describe("batchTranslate (per-segment Bing requests)", () => {
  it("matches words against single segment Chinese translation", async () => {
    mockBingTranslate.mockResolvedValueOnce(
      "这是测试页面。学生需要适应新环境。成绩很重要。"
    );

    mockLookup.mockImplementation((word: string) => {
      const dict: Record<string, { def: string; cn: string[] }> = {
        test: { def: "n. 测验；测试；考验", cn: ["测验", "考试", "测试", "考验"] },
        student: { def: "n. 学生；学者", cn: ["学生", "学者"] },
        adapt: { def: "v. 适应；改编", cn: ["适应", "改编"] },
        result: { def: "n. 结果；成绩；成果", cn: ["结果", "成绩", "成果"] },
      };
      return dict[word.toLowerCase()] ?? undefined;
    });

    const result = await batchTranslate(
      ["test", "student", "adapt", "result"],
      ["This is a test page. Students need to adapt to the new environment. Results are important."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["test"]).toBe("测试");
    expect(result["student"]).toBe("学生");
    expect(result["adapt"]).toBe("适应");
    expect(result["result"]).toBe("成绩");
  });

  it("exact match beats char fallback", async () => {
    mockBingTranslate.mockResolvedValue("这是一种新的方法。");
    mockLookup.mockImplementation((word: string) => {
      if (word === "new") return { def: "adj. 新出现的；崭新的；新的", cn: ["新出现的", "崭新的", "新的"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["new"],
      ["This is a new approach."]
    );

    expect(result["new"]).toBe("新的");
  });

  it("returns cn[0] fallback when Bing fails", async () => {
    mockBingTranslate.mockRejectedValueOnce(new Error("Bing error"));
    mockLookup.mockImplementation((word: string) => {
      if (word === "need") return { def: "v. 需要；必需 n. 需要；必要之物", cn: ["需要", "必需"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["need"],
      ["I need to go to the store"]
    );

    expect(result["need"]).toBe("需要");
  });

  it("handles empty words list", async () => {
    const result = await batchTranslate([], ["some text"]);
    expect(result).toEqual({});
  });

  it("handles empty segments list", async () => {
    const result = await batchTranslate(["test"], []);
    expect(result).toEqual({});
  });

  it("processes multiple segments with one Bing call each", async () => {
    mockBingTranslate
      .mockResolvedValueOnce("这是第一段。")
      .mockResolvedValueOnce("这是第二段。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "first") return { def: "det. 第一", cn: ["第一"] };
      if (word === "second") return { def: "det. 第二", cn: ["第二"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["first", "second"],
      ["This is the first segment.", "This is the second segment."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(2);
    expect(result["first"]).toBe("第一");
    expect(result["second"]).toBe("第二");
  });

  it("skips segments that don't contain relevant words", async () => {
    mockBingTranslate.mockResolvedValue("重要信息。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "important") return { def: "adj. 重要的", cn: ["重要的"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["important"],
      ["irrelevant text without keywords", "this is important"]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["important"]).toBe("重要的");
  });

  it("falls back to dict cn[0] for words not found in any segment", async () => {
    mockBingTranslate.mockResolvedValue("其他文本。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "present") return { def: "adj. 在场的；现在的", cn: ["在场的", "现在的"] };
      if (word === "absent") return { def: "adj. 缺席的", cn: ["缺席的"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["present", "absent"],
      ["The absent student missed class."]
    );

    expect(result["absent"]).toBe("缺席的");
    expect(result["present"]).toBe("在场的");
  });
});
