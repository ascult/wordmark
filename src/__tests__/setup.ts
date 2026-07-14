import { vi } from "vitest";

const mockStorage: Record<string, unknown> = {};

const mockChrome = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
        if (Array.isArray(keys)) {
          const result: Record<string, unknown> = {};
          for (const key of keys) {
            result[key] = mockStorage[key] ?? undefined;
          }
          return result;
        }
        if (typeof keys === "object" && keys !== null) {
          const result: Record<string, unknown> = {};
          for (const [key, defaultValue] of Object.entries(keys)) {
            result[key] = mockStorage[key] ?? defaultValue;
          }
          return result;
        }
        return { ...mockStorage };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
          delete mockStorage[key];
        }
      }),
      clear: vi.fn(async () => {
        Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
      }),
    },
  },
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(),
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
  },
  commands: {
    onCommand: { addListener: vi.fn() },
  },
};

vi.stubGlobal("chrome", mockChrome);

export function resetMockStorage(): void {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
}

export function setMockStorage(data: Record<string, unknown>): void {
  Object.assign(mockStorage, data);
}
