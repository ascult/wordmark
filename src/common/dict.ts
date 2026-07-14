import dictData from "./dict.json" with { type: "json" };

export interface DictEntry {
  def: string;
  cn: string[];
}

export const BUNDLED_DICT: Record<string, DictEntry> = dictData as Record<
  string,
  DictEntry
>;

export function lookup(word: string): DictEntry | undefined {
  return BUNDLED_DICT[word.toLowerCase()];
}
