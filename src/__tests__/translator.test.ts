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
    mockLookup.mockReturnValueOnce({ def: "v. 构建；建造", cn: ["构建", "建造"] });
    const result = await translate("build");
    expect(result).toBe("v. 构建；建造");
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
      "这是一个声明式库。构建封装组件来管理状态。"
    );

    mockLookup.mockImplementation((word: string) => {
      const dict: Record<string, { def: string; cn: string[] }> = {
        library: { def: "n. 图书馆；库", cn: ["图书馆", "库"] },
        build: { def: "v. 构建；建造", cn: ["构建", "建造"] },
        component: { def: "n. 组件；部件", cn: ["组件", "部件"] },
      };
      return dict[word.toLowerCase()] ?? undefined;
    });

    const result = await batchTranslate(
      ["library", "build", "component"],
      ["A declarative library. Build encapsulated components that manage state."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["library"]).toBe("库");
    expect(result["build"]).toBe("构建");
    expect(result["component"]).toBe("组件");
  });

  it("exact match beats char fallback", async () => {
    mockBingTranslate.mockResolvedValue("React 是一个声明式库。");
    mockLookup.mockImplementation((word: string) => {
      if (word === "library") return { def: "n. 图书馆；库；丛书", cn: ["图书馆", "库", "丛书"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["library"],
      ["React is a declarative library."]
    );

    expect(result["library"]).toBe("库");
  });

  it("returns cn[0] fallback when Bing fails", async () => {
    mockBingTranslate.mockRejectedValueOnce(new Error("Bing error"));
    mockLookup.mockImplementation((word: string) => {
      if (word === "build") return { def: "v. 构建；建造 n. 构建版本", cn: ["构建", "建造"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["build"],
      ["npm run build"]
    );

    expect(result["build"]).toBe("构建");
  });

  it("handles empty words list", async () => {
    const result = await batchTranslate([], ["npm install react"]);
    expect(result).toEqual({});
  });

  it("handles empty segments list", async () => {
    const result = await batchTranslate(["react"], []);
    expect(result).toEqual({});
  });

  it("processes multiple segments with one Bing call each", async () => {
    mockBingTranslate
      .mockResolvedValueOnce("从安装开始。")
      .mockResolvedValueOnce("构建并部署。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "install") return { def: "v. 安装", cn: ["安装"] };
      if (word === "deploy") return { def: "v. 部署", cn: ["部署"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["install", "deploy"],
      ["Start with installation.", "Build and deploy."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(2);
    expect(result["install"]).toBe("安装");
    expect(result["deploy"]).toBe("部署");
  });

  it("skips segments that don't contain relevant words", async () => {
    mockBingTranslate.mockResolvedValue("设计用于逐步采用。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "design") return { def: "v. 设计", cn: ["设计"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["design"],
      ["npm install react", "Designed for gradual adoption."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["design"]).toBe("设计");
  });

  it("falls back to dict cn[0] for words not found in any segment", async () => {
    mockBingTranslate.mockResolvedValue("库已安装。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "library") return { def: "n. 库", cn: ["库"] };
      if (word === "component") return { def: "n. 组件", cn: ["组件"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["library", "component"],
      ["Library installed."]
    );

    expect(result["library"]).toBe("库");
    expect(result["component"]).toBe("组件");
  });
});
