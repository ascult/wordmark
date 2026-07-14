const STORAGE_KEY = "_wm_segment_cache";
const MAX_ENTRIES = 500;
const CACHE_TTL = 24 * 60 * 60 * 1000;

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
  const now = Date.now();
  let expired = 0;
  for (const [key, entry] of Object.entries(stored)) {
    if (now - entry.timestamp < CACHE_TTL) {
      cacheMap.set(key, entry);
    } else {
      expired++;
    }
  }
  loaded = true;
  if (expired > 0) await pruneStorage();
}

async function persistCache(): Promise<void> {
  const stored: Record<string, CacheEntry> = {};
  const entries = [...cacheMap.entries()].slice(-MAX_ENTRIES);
  for (const [key, entry] of entries) {
    stored[key] = entry;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

async function pruneStorage(): Promise<void> {
  const now = Date.now();
  for (const [key, entry] of cacheMap) {
    if (now - entry.timestamp >= CACHE_TTL) cacheMap.delete(key);
  }
  if (cacheMap.size > MAX_ENTRIES) {
    const oldest = [...cacheMap.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, cacheMap.size - MAX_ENTRIES);
    for (const [key] of oldest) cacheMap.delete(key);
  }
  await persistCache();
}

export async function getCached(segHash: string): Promise<string | undefined> {
  await loadCache();
  const entry = cacheMap.get(segHash);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp >= CACHE_TTL) {
    cacheMap.delete(segHash);
    await persistCache();
    return undefined;
  }
  return entry.zhText;
}

export async function setCached(segHash: string, zhText: string): Promise<void> {
  await loadCache();
  cacheMap.set(segHash, { zhText, timestamp: Date.now() });
  if (cacheMap.size > MAX_ENTRIES + 50) await pruneStorage();
  else await persistCache();
}
