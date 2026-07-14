import { describe, it, expect, beforeEach } from "vitest";
import { isDomainAllowed } from "../content/dom-walker.js";
import type { Settings } from "../common/types.js";

describe("isDomainAllowed", () => {
  const defaultSettings: Settings = {
    enabled: true,
    whitelist: [],
    blacklist: [],
    importSampleDone: true,
    cet4Enabled: false,
    cet6Enabled: false,
  };

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: { hostname: "example.com", href: "https://example.com/page" },
      writable: true,
      configurable: true,
    });
  });

  it("allows when both lists are empty", () => {
    expect(isDomainAllowed(defaultSettings)).toBe(true);
  });

  it("blocks domain in blacklist", () => {
    const settings = { ...defaultSettings, blacklist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(false);
  });

  it("allows domain not in blacklist", () => {
    const settings = { ...defaultSettings, blacklist: ["blocked.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("blocks subdomain via blacklist", () => {
    const settings = { ...defaultSettings, blacklist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(false);
  });

  it("blocks domain not in whitelist", () => {
    const settings = { ...defaultSettings, whitelist: ["allowed.com"] };
    expect(isDomainAllowed(settings)).toBe(false);
  });

  it("allows domain in whitelist", () => {
    const settings = { ...defaultSettings, whitelist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("allows subdomain matching whitelist", () => {
    Object.defineProperty(window, "location", {
      value: { hostname: "sub.example.com", href: "https://sub.example.com/page" },
      writable: true,
      configurable: true,
    });
    const settings = { ...defaultSettings, whitelist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("whitelist takes precedence over blacklist", () => {
    const settings = {
      ...defaultSettings,
      whitelist: ["example.com"],
      blacklist: ["example.com"],
    };
    expect(isDomainAllowed(settings)).toBe(true);
  });
});
