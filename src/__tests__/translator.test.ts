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
    mockLookup.mockReturnValueOnce({ def: "v. 安装；设置", cn: ["安装", "设置"] });
    const result = await translate("install");
    expect(result).toBe("v. 安装；设置");
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
      "这是安装指南。运行构建命令来编译项目。配置需要遵循规范。"
    );

    mockLookup.mockImplementation((word: string) => {
      const dict: Record<string, { def: string; cn: string[] }> = {
        install: { def: "v. 安装；设置", cn: ["安装", "设置"] },
        build: { def: "v. 构建；建造", cn: ["构建", "建造", "编译"] },
        config: { def: "n. 配置；设置", cn: ["配置", "设置"] },
      };
      return dict[word.toLowerCase()] ?? undefined;
    });

    const result = await batchTranslate(
      ["install", "build", "config"],
      ["Run the install command to build the project. Config follows the standard."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["install"]).toBe("安装");
    expect(result["build"]).toBe("构建");
    expect(result["config"]).toBe("配置");
  });

  it("exact match beats char fallback", async () => {
    mockBingTranslate.mockResolvedValue("这是一个新的库。");
    mockLookup.mockImplementation((word: string) => {
      if (word === "library") return { def: "n. 图书馆；库；丛书", cn: ["图书馆", "库", "丛书"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["library"],
      ["This is a new library."]
    );

    expect(result["library"]).toBe("库");
  });

  it("returns cn[0] fallback when Bing fails", async () => {
    mockBingTranslate.mockRejectedValueOnce(new Error("Bing error"));
    mockLookup.mockImplementation((word: string) => {
      if (word === "install") return { def: "v. 安装；设置 n. 安装程序", cn: ["安装", "设置"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["install"],
      ["npm install --save react"]
    );

    expect(result["install"]).toBe("安装");
  });

  it("handles empty words list", async () => {
    const result = await batchTranslate([], ["npm install"]);
    expect(result).toEqual({});
  });

  it("handles empty segments list", async () => {
    const result = await batchTranslate(["install"], []);
    expect(result).toEqual({});
  });

  it("processes multiple segments with one Bing call each", async () => {
    mockBingTranslate
      .mockResolvedValueOnce("安装依赖项。")
      .mockResolvedValueOnce("构建并运行。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "install") return { def: "v. 安装", cn: ["安装"] };
      if (word === "build") return { def: "v. 构建", cn: ["构建"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["install", "build"],
      ["Install dependencies.", "Build and run."]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(2);
    expect(result["install"]).toBe("安装");
    expect(result["build"]).toBe("构建");
  });

  it("skips segments that don't contain relevant words", async () => {
    mockBingTranslate.mockResolvedValue("项目配置说明。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "config") return { def: "n. 配置", cn: ["配置"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["config"],
      ["This segment has no CET words", "Project configuration guide"]
    );

    expect(mockBingTranslate).toHaveBeenCalledTimes(1);
    expect(result["config"]).toBe("配置");
  });

  it("falls back to dict cn[0] for words not found in any segment", async () => {
    mockBingTranslate.mockResolvedValue("已安装依赖项。");

    mockLookup.mockImplementation((word: string) => {
      if (word === "install") return { def: "v. 安装", cn: ["安装"] };
      if (word === "deploy") return { def: "v. 部署；配置", cn: ["部署", "配置"] };
      return undefined;
    });

    const result = await batchTranslate(
      ["install", "deploy"],
      ["Dependencies installed."]
    );

    expect(result["install"]).toBe("安装");
    expect(result["deploy"]).toBe("部署");
  });
});
