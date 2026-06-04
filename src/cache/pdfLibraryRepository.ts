import type { PdfFingerprint, PdfLibraryEntry } from "../types/domain";
import { getAppDb } from "./indexedDb";

type ImportedPdfInput = PdfFingerprint & {
  blob: Blob;
  cloudDocumentId?: string;
  storagePath?: string;
};

export async function listPdfLibraryEntries() {
  const db = await getAppDb();
  const entries = await db.getAll("pdfLibrary");

  return entries
    .filter((entry) => !entry.deletedAt && entry.blob instanceof Blob)
    .sort((left, right) => left.fileName.localeCompare(
      right.fileName,
      undefined,
      { numeric: true, sensitivity: "base" },
    ));
}

export async function getPdfLibraryEntry(fingerprint: string) {
  const db = await getAppDb();
  const entry = await db.get("pdfLibrary", fingerprint);

  if (!entry || entry.deletedAt) {
    return undefined;
  }

  return entry;
}

export async function saveImportedPdf(input: ImportedPdfInput) {
  const db = await getAppDb();
  const existing = await db.get("pdfLibrary", input.fingerprint);
  const now = Date.now();

  const entry: PdfLibraryEntry = existing
    ? {
        ...existing,
        cloudDocumentId: input.cloudDocumentId ?? existing.cloudDocumentId,
        contentSha256: input.contentSha256 ?? existing.contentSha256,
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: "application/pdf",
        blob: existing.deletedAt ? input.blob : existing.blob,
        lastOpenedAt: now,
        openCount: existing.openCount + 1,
        pdfMetadata: input.pdfMetadata ?? existing.pdfMetadata,
        storagePath: input.storagePath ?? existing.storagePath,
        deletedAt: undefined,
      }
    : {
        cloudDocumentId: input.cloudDocumentId,
        contentSha256: input.contentSha256,
        fingerprint: input.fingerprint,
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: "application/pdf",
        blob: input.blob,
        importedAt: now,
        lastOpenedAt: now,
        openCount: 1,
        pdfMetadata: input.pdfMetadata,
        storagePath: input.storagePath,
      };

  await db.put("pdfLibrary", entry);

  return entry;
}

export async function markPdfOpened(fingerprint: string) {
  const entry = await getPdfLibraryEntry(fingerprint);

  if (!entry) {
    throw new Error("PDF record was not found in local library.");
  }

  const updatedEntry: PdfLibraryEntry = {
    ...entry,
    lastOpenedAt: Date.now(),
    openCount: entry.openCount + 1,
  };

  const db = await getAppDb();
  await db.put("pdfLibrary", updatedEntry);

  return updatedEntry;
}

export type ReadingPositionUpdate = Pick<
  PdfLibraryEntry,
  "lastPageIndex" | "lastScrollTop" | "lastZoom"
>;

export async function updatePdfReadingPosition(
  fingerprint: string,
  position: ReadingPositionUpdate,
) {
  const entry = await getPdfLibraryEntry(fingerprint);

  if (!entry) {
    return undefined;
  }

  const updatedEntry: PdfLibraryEntry = {
    ...entry,
    lastPageIndex: position.lastPageIndex,
    lastScrollTop: position.lastScrollTop,
    lastZoom: position.lastZoom ?? entry.lastZoom,
  };

  const db = await getAppDb();
  await db.put("pdfLibrary", updatedEntry);

  return updatedEntry;
}

export async function deletePdfLocalData(fingerprint: string) {
  const db = await getAppDb();
  const [pinKeys, apiLogKeys, pinnedTranslationCardKeys, translationCacheKeys] = await Promise.all([
    db.getAllKeysFromIndex("pins", "by-pdf", fingerprint),
    db.getAllKeysFromIndex("apiLogs", "by-pdf", fingerprint),
    db.getAllKeysFromIndex("pinnedTranslationCards", "by-pdf", fingerprint),
    db.getAllKeysFromIndex("translationCache", "by-pdf", fingerprint),
  ]);

  await Promise.all([
    db.delete("pdfLibrary", fingerprint),
    db.delete("paperContexts", fingerprint),
    ...pinKeys.map((key) => db.delete("pins", key)),
    ...apiLogKeys.map((key) => db.delete("apiLogs", key)),
    ...pinnedTranslationCardKeys.map((key) => db.delete("pinnedTranslationCards", key)),
    ...translationCacheKeys.map((key) => db.delete("translationCache", key)),
  ]);
}
