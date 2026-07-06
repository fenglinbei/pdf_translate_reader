import type { TranslationLanguage } from "../config/translationLanguages";
import type { UiLocale } from "../i18n/uiLocales";

export type TranslationModel = "deepseek-v4-flash" | "deepseek-v4-pro";
export type SelectionMode = "continuous" | "cross";
export type MobileInteractionMode = "pan" | "segmented";
export type SourceLanguage = TranslationLanguage;
export type TargetLanguage = TranslationLanguage;
export type AnnotationColor = "yellow" | "blue" | "green" | "red";
export type TextExtractionSource = "pdfjs" | "mathpix-v3-pdf";
export type TranslationRequestKind = "selection" | "free";
export type TranslationStylePresetId =
  | "academic-faithful"
  | "academic-fluent"
  | "concise-literal"
  | "publication-polished"
  | "reader-friendly"
  | "custom";
export type TranslationStyleSettings = {
  customInstruction?: string;
  presetId: TranslationStylePresetId;
};
export type MathpixParseStatus =
  | "submitted"
  | "processing"
  | "completed"
  | "error"
  | "deleted";

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
  lastZoom?: number;
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
  mathpixConfidence?: number;
  mathpixOptionsHash?: string;
  nativeTargetSentence?: string;
  selectedText: string;
  targetSentence: string;
  textSource?: TextExtractionSource;
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
  mathpixConfidence?: number;
  mathpixOptionsHash?: string;
  nativeTargetSentence?: string;
  selectedText: string;
  targetSentence: string;
  textSource?: TextExtractionSource;
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
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
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
  requestKind: TranslationRequestKind;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  textSource?: TextExtractionSource;
  mathpixOptionsHash?: string;
  model: TranslationModel;
  targetSentence: string;
  localContextBefore: string[];
  localContextAfter: string[];
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContext?: PaperContext;
  promptVersion: string;
  stream: boolean;
  terminologyOverride?: PaperContextTerm[];
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
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
  textSource?: TextExtractionSource;
  mathpixOptionsHash?: string;
  model: TranslationModel;
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
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
  textSource?: TextExtractionSource;
  mathpixOptionsHash?: string;
  mathpixConfidence?: number;
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
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
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
  textSource?: TextExtractionSource;
  mathpixOptionsHash?: string;
  requestStartedAt: number;
  requestFinishedAt?: number;
  status: "success" | "error" | "aborted";
  errorMessage?: string;
  promptVersion: string;
  requestKind: TranslationRequestKind;
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};

export type QaScope = "current" | "current-plus-references" | "library";
export type QaIndexSource = TextExtractionSource;
export type QaIndexJobStatus =
  | "pending"
  | "extracting"
  | "chunking"
  | "embedding"
  | "reference-matching"
  | "ready"
  | "ready_degraded"
  | "error";
export type QaCitationConfidence = "verified" | "weak" | "rejected";
export type QaMessageStatus = "streaming" | "success" | "error" | "aborted";
export type QaMessageRole = "user" | "assistant";

export type QaChunk = {
  id: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  contentSha256: string;
  chunkIndex: number;
  chunkHash: string;
  title?: string;
  sectionPath?: string[];
  pageStart: number;
  pageEnd: number;
  text: string;
  mmd?: string;
  tokenCount: number;
  source: QaIndexSource;
  chunkerVersion: string;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type QaCitation = {
  id: string;
  messageId: string;
  chunkId: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  sectionPath?: string[];
  quotedText: string;
  confidence: QaCitationConfidence;
  createdAt: number;
  deletedAt?: number;
};

export type QaRetrievedEvidence = {
  evidenceId: string;
  chunkId: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  documentTitle: string;
  pageStart: number;
  pageEnd: number;
  sectionPath?: string[];
  score: number;
  scoreBreakdown: {
    vector?: number;
    fullText?: number;
    metadataBoost?: number;
    rerank?: number;
  };
  textPreview: string;
};

export type QaRetrievalSnapshot = {
  scope: QaScope;
  activeCloudDocumentId?: string;
  referenceDocumentIds: string[];
  queryPlan: {
    intent: string;
    rewrittenQueries: string[];
    requiredEvidence: "single" | "multi" | "comparison";
    answerFormat: "paragraph" | "bullets" | "table";
  };
  retrieverVersion: string;
  rerankerVersion?: string;
  evidence: QaRetrievedEvidence[];
};

export type QaThread = {
  id: string;
  activeCloudDocumentId?: string;
  title: string;
  scope: QaScope;
  referenceDocumentIds: string[];
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type QaMessage = {
  id: string;
  threadId: string;
  role: QaMessageRole;
  content: string;
  status: QaMessageStatus;
  citations: QaCitation[];
  retrievalSnapshot?: QaRetrievalSnapshot;
  usage?: TokenUsage;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type QaIndexJob = {
  id: string;
  cloudDocumentId: string;
  pdfFingerprint: string;
  contentSha256: string;
  source: QaIndexSource;
  status: QaIndexJobStatus;
  chunkerVersion: string;
  embeddingModel: string;
  embeddingDimensions?: number;
  referenceMatcherVersion: string;
  retrieverVersion: string;
  progressPercent?: number;
  errorMessage?: string;
  payload?: unknown;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type QaApiLog = {
  id: string;
  cloudDocumentId?: string;
  pdfFingerprint?: string;
  threadId?: string;
  messageId?: string;
  requestKind: "index-job" | "answer-stream" | "retrieval" | "citation-verification";
  status: "success" | "error" | "aborted";
  model?: TranslationModel;
  promptVersion?: string;
  retrieverVersion?: string;
  payload?: unknown;
  requestStartedAt: number;
  requestFinishedAt?: number;
  errorMessage?: string;
  usage?: TokenUsage;
};

export type AppSettings = {
  contextWindowN: 0 | 1 | 2 | 3 | 5;
  defaultModel: TranslationModel;
  longContextEnabled: boolean;
  maxDraggedWords: number;
  selectedTextOutputMode: "processed" | "native";
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  textSelectionMode: "mathpix" | "original";
  uiLocale: UiLocale;
};

export type MathpixLineRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MathpixParsedLine = {
  confidence?: number;
  confidenceRate?: number;
  cnt?: Array<[number, number]>;
  isHandwritten?: boolean;
  isPrinted?: boolean;
  lineIndex: number;
  region?: MathpixLineRegion;
  text: string;
};

export type MathpixParsedPage = {
  cloudDocumentId?: string;
  lineCount: number;
  lines: MathpixParsedLine[];
  mathpixOptionsHash: string;
  minConfidence?: number;
  pageHeight?: number;
  pageIndex: number;
  pageMmd: string;
  pageText: string;
  pageWidth?: number;
  pdfFingerprint: string;
  source: "mathpix-v3-pdf";
  updatedAt: number;
};

export type MathpixDocumentRecord = {
  cloudDocumentId?: string;
  completedAt?: number;
  contentSha256?: string;
  deleteRemoteAfterCache?: boolean;
  errorMessage?: string;
  fileName: string;
  fileSize: number;
  fullMmd?: string;
  fullMmdStoragePath?: string;
  mathpixOptionsHash: string;
  mathpixPdfId?: string;
  numPages?: number;
  numPagesCompleted?: number;
  pagesStoragePath?: string;
  pdfFingerprint: string;
  percentDone?: number;
  cloudMathpixSyncedAt?: number;
  remoteDeletedAt?: number;
  status: MathpixParseStatus;
  submittedAt?: number;
  updatedAt: number;
};
