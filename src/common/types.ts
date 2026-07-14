export interface VocabularyEntry {
  id: string;
  word: string;
  definition: string;
  createdAt: number;
}

export interface VocabInfo {
  definition?: string;
  source: "custom" | "cet";
}

export interface Settings {
  enabled: boolean;
  whitelist: string[];
  blacklist: string[];
  importSampleDone: boolean;
  cet4Enabled: boolean;
  cet6Enabled: boolean;
}

export interface StorageData {
  vocabList: VocabularyEntry[];
  settings: Settings;
}

export type MessageType =
  | "vocab-updated"
  | "toggle-replace"
  | "get-match-count"
  | "translate-word";

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}
