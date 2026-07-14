import { TRANSLATION_TIMEOUT, TRANSLATION_RETRIES } from "../common/constants.js";

// Uses MyMemory API (free, no key required for limited use)
const API_URL = "https://api.mymemory.translated.net/get";

export async function translate(word: string): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= TRANSLATION_RETRIES; attempt++) {
    try {
      return await fetchTranslation(word);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < TRANSLATION_RETRIES) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("Translation failed");
}

async function fetchTranslation(word: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT);

  try {
    const url = `${API_URL}?q=${encodeURIComponent(word)}&langpair=en|zh-CN`;
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json();
    const translation: string | undefined = data?.responseData?.translatedText;

    if (!translation || translation === word) {
      throw new Error("Empty translation result");
    }

    return translation;
  } finally {
    clearTimeout(timer);
  }
}
