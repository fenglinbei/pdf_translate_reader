import type {
  PaperContextRecord,
  PdfMetadata,
  TranslationCacheEntry,
  TranslationPin,
} from "../types/domain";
import type { StoredPinnedTranslationCard } from "../translation/floatingCardTypes";

export const DOCUMENT_ARCHIVE_FORMAT = "pdf-translate-reader.archive";
export const DOCUMENT_ARCHIVE_VERSION = 1;
export const DOCUMENT_ARCHIVE_MANIFEST_NAME = "manifest.json";
export const DOCUMENT_ARCHIVE_PDF_NAME = "document.pdf";

export type DocumentArchiveDocument = {
  contentSha256?: string;
  fileName: string;
  fileSize: number;
  fingerprint: string;
  lastPageIndex?: number;
  lastScrollTop?: number;
  lastZoom?: number;
  mimeType: "application/pdf";
  pdfMetadata?: PdfMetadata;
};

export type DocumentArchiveState = {
  paperContext?: PaperContextRecord;
  pinnedTranslationCards: StoredPinnedTranslationCard[];
  pins: TranslationPin[];
  translationCache: TranslationCacheEntry[];
};

export type DocumentArchiveManifestV1 = {
  document: DocumentArchiveDocument;
  exportedAt: string;
  format: typeof DOCUMENT_ARCHIVE_FORMAT;
  formatVersion: typeof DOCUMENT_ARCHIVE_VERSION;
  state: DocumentArchiveState;
};

export type ParsedDocumentArchive = {
  manifest: DocumentArchiveManifestV1;
  pdfFile: File;
};
