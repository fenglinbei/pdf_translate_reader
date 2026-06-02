export type TranslationModel = "deepseek-v4-flash" | "deepseek-v4-pro";
export type SourceLanguage = "en";
export type TargetLanguage = "zh";

export type DOMRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type PdfFingerprint = {
  fingerprint: string;
  fileName: string;
  fileSize: number;
  modifiedAt?: number;
  pdfMetadata?: PdfMetadata;
};

export type PdfMetadata = {
  title?: string;
  author?: string;
};

export type PdfLibraryEntry = {
  fingerprint: string;
  fileName: string;
  fileSize: number;
  mimeType: "application/pdf";
  blob: Blob;
  importedAt: number;
  lastOpenedAt: number;
  openCount: number;
  lastPageIndex?: number;
  lastScrollTop?: number;
  pdfMetadata?: PdfMetadata;
  deletedAt?: number;
};

export type SentenceSelection = {
  pdfFingerprint: string;
  pageIndex: number;
  pageHeight?: number;
  pageWidth?: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  rectsOnPage: DOMRectLike[];
  textSpan: {
    startGlobalChar: number;
    endGlobalChar: number;
  };
};

export type PaperContext = {
  title?: string;
  abstract?: string;
  terminology: Array<{
    source: string;
    target: string;
    confidence: "auto" | "user";
    updatedAt: number;
  }>;
  contextHash: string;
};

export type TranslationRequest = {
  pdfFingerprint: string;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  model: TranslationModel;
  targetSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContext?: PaperContext;
  promptVersion: string;
  stream: boolean;
};

export type TokenUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};

export type TranslationCacheEntry = {
  cacheKey: string;
  pdfFingerprint: string;
  normalizedSentence: string;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  model: TranslationModel;
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
  translation: string;
  usage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
};

export type TranslationPin = {
  id: string;
  pdfFingerprint: string;
  pageIndex: number;
  pageHeight?: number;
  pageWidth?: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  rectsOnPage: DOMRectLike[];
  translation: string;
  sourceLang: SourceLanguage;
  model: TranslationModel;
  targetLang: TargetLanguage;
  contextWindowN: number;
  longContextEnabled: boolean;
  cacheKey?: string;
  highlighted?: boolean;
  promptVersion: string;
  createdAt: number;
  updatedAt: number;
};

export type ApiCallLog = {
  id: string;
  pdfFingerprint: string;
  model: TranslationModel;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  requestStartedAt: number;
  requestFinishedAt?: number;
  status: "success" | "error" | "aborted";
  errorMessage?: string;
  promptVersion: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};

export type AppSettings = {
  contextWindowN: 0 | 1 | 2 | 3 | 5;
  defaultModel: TranslationModel;
  longContextEnabled: boolean;
  maxDraggedWords: number;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
};
