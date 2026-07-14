export interface VocabularyEntry {
  id: string;
  word: string;
  definition: string;
  createdAt: number;
}

export interface Settings {
  enabled: boolean;
  whitelist: string[];
  blacklist: string[];
  importSampleDone: boolean;
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
