const STORAGE_KEY = "_wm_segment_cache";
const MAX_ENTRIES = 5000;

interface CacheEntry {
  zhText: string;
  timestamp: number;
}

let cacheMap = new Map<string, CacheEntry>();
let loaded = false;

async function loadCache(): Promise<void> {
  if (loaded) return;
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  const stored: Record<string, CacheEntry> = raw[STORAGE_KEY] ?? {};
  for (const [key, entry] of Object.entries(stored)) {
    cacheMap.set(key, entry);
  }
  loaded = true;
  if (cacheMap.size > MAX_ENTRIES) await evict();
}

async function persist(): Promise<void> {
  const stored: Record<string, CacheEntry> = {};
  const entries = [...cacheMap.entries()];
  for (const [key, entry] of entries) {
    stored[key] = entry;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

async function evict(): Promise<void> {
  while (cacheMap.size > MAX_ENTRIES) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [key, entry] of cacheMap) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) cacheMap.delete(oldestKey);
  }
  await persist();
}

export async function getCached(segHash: string): Promise<string | undefined> {
  await loadCache();
  const entry = cacheMap.get(segHash);
  return entry?.zhText;
}

export async function setCached(segHash: string, zhText: string): Promise<void> {
  await loadCache();
  cacheMap.set(segHash, { zhText, timestamp: Date.now() });
  if (cacheMap.size > MAX_ENTRIES) await evict();
  else await persist();
}
