export const PROJECT_CONFIG = {
  api: {
    translationTimeoutMs: 90000,
  },
  paperContext: {
    maxAbstractCharacters: 1800,
    maxScanPages: 3,
  },
  selection: {
    defaultMaxDraggedWords: 128,
    maxDraggedWordsLimit: 512,
    minDraggedWordsLimit: 1,
  },
} as const;
