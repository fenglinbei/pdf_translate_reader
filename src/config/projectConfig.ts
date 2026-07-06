export const PROJECT_CONFIG = {
  api: {
    qaAnswerTimeoutMs: 180000,
    translationTimeoutMs: 90000,
  },
  paperContext: {
    maxAbstractCharacters: 1800,
    maxScanPages: 3,
  },
  qa: {
    answerPromptVersion: "qa-answer-v1",
    chunkerVersion: "qa-chunker-v1",
    indexStatusPollMs: 3000,
    referenceMatcherVersion: "reference-matcher-v1",
    retrieverVersion: "hybrid-retriever-v1",
  },
  selection: {
    defaultMaxDraggedWords: 128,
    maxDraggedWordsLimit: 512,
    minDraggedWordsLimit: 1,
  },
} as const;
