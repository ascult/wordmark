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
    });
  });

  it("allows domain when no whitelist or blacklist is set", () => {
    expect(isDomainAllowed(defaultSettings)).toBe(true);
  });

  it("allows domain even with blacklist set", () => {
    const settings = { ...defaultSettings, blacklist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("allows domain even with whitelist set", () => {
    const settings = { ...defaultSettings, whitelist: ["allowed.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("allows subdomain matching whitelist", () => {
    Object.defineProperty(window, "location", {
      value: { hostname: "sub.example.com", href: "https://sub.example.com/page" },
      writable: true,
    });
    const settings = { ...defaultSettings, whitelist: ["example.com"] };
    expect(isDomainAllowed(settings)).toBe(true);
  });

  it("allows all when both lists are empty", () => {
    const settings = { ...defaultSettings, whitelist: [], blacklist: [] };
    expect(isDomainAllowed(settings)).toBe(true);
  });
});
