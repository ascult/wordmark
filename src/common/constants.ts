export const STORAGE_KEYS = {
  VOCAB_LIST: "vocabList",
  SETTINGS: "settings",
} as const;

export const DEFAULT_SETTINGS = {
  enabled: false,
  whitelist: [],
  blacklist: [],
  importSampleDone: false,
} as const;

export const TRANSLATION_TIMEOUT = 5000;
export const TRANSLATION_RETRIES = 2;

export const ANNOTATION_CLASS = "wm-annotated";
export const ANNOTATION_STYLE = "background-color: #fff3cd;";
