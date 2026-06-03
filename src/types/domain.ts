import type { TranslationLanguage } from "../config/translationLanguages";

export type TranslationModel = "deepseek-v4-flash" | "deepseek-v4-pro";
export type ReaderMode = "translate" | "select";
export type SelectionMode = "continuous" | "cross";
export type SourceLanguage = TranslationLanguage;
export type TargetLanguage = TranslationLanguage;
export type AnnotationColor = "yellow" | "blue" | "green" | "red";

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
  contentSha256: string;
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
  cloudDocumentId?: string;
  contentSha256?: string;
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
  storagePath?: string;
  deletedAt?: number;
};

export type CloudPdfLibraryEntry = Omit<PdfLibraryEntry, "blob"> & {
  cloudDocumentId: string;
  contentSha256: string;
  localCached?: boolean;
  storagePath: string;
};

export type SelectionRegion = {
  pageIndex: number;
  pageHeight?: number;
  pageWidth?: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  rectsOnPage: DOMRectLike[];
  textSpan: {
    startGlobalChar: number;
    endGlobalChar: number;
  };
};

export type SentenceSelection = {
  cloudDocumentId?: string;
  pdfFingerprint: string;
  pageIndex: number;
  anchorRegionIndex?: number;
  pageHeight?: number;
  pageWidth?: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  rectsOnPage: DOMRectLike[];
  regions?: SelectionRegion[];
  textSpan: {
    startGlobalChar: number;
    endGlobalChar: number;
  };
};

export type PaperContextTerm = {
  source: string;
  target: string;
  confidence: "auto" | "user";
  updatedAt: number;
};

export type PaperContext = {
  title?: string;
  abstract?: string;
  terminology: PaperContextTerm[];
  contextHash: string;
};

export type PaperContextRecord = PaperContext & {
  cloudDocumentId?: string;
  pdfFingerprint: string;
  updatedAt: number;
  userEditedAt?: number;
};

export type TranslationRequest = {
  cloudDocumentId?: string;
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
  cloudDocumentId?: string;
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
  cloudDocumentId?: string;
  pdfFingerprint: string;
  pageIndex: number;
  anchorRegionIndex?: number;
  pageHeight?: number;
  pageWidth?: number;
  selectedText: string;
  targetSentence: string;
  normalizedSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  rectsOnPage: DOMRectLike[];
  regions?: SelectionRegion[];
  translation: string;
  sourceLang: SourceLanguage;
  model: TranslationModel;
  targetLang: TargetLanguage;
  contextWindowN: number;
  longContextEnabled: boolean;
  cacheKey?: string;
  highlighted?: boolean;
  note?: string;
  color?: AnnotationColor;
  translationVisible?: boolean;
  promptVersion: string;
  createdAt: number;
  updatedAt: number;
};

export type ApiCallLog = {
  id: string;
  cloudDocumentId?: string;
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
