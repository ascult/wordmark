export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}
