import type { PdfFingerprint, PdfLibraryEntry } from "../types/domain";
import { getAppDb } from "./indexedDb";

type ImportedPdfInput = PdfFingerprint & {
  blob: Blob;
};

export async function listPdfLibraryEntries() {
  const db = await getAppDb();
  const entries = await db.getAll("pdfLibrary");

  return entries
    .filter((entry) => !entry.deletedAt && entry.blob instanceof Blob)
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
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
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: "application/pdf",
        blob: existing.deletedAt ? input.blob : existing.blob,
        lastOpenedAt: now,
        openCount: existing.openCount + 1,
        pdfMetadata: input.pdfMetadata ?? existing.pdfMetadata,
        deletedAt: undefined,
      }
    : {
        fingerprint: input.fingerprint,
        fileName: input.fileName,
        fileSize: input.fileSize,
        mimeType: "application/pdf",
        blob: input.blob,
        importedAt: now,
        lastOpenedAt: now,
        openCount: 1,
        pdfMetadata: input.pdfMetadata,
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

export type ReadingPositionUpdate = Pick<PdfLibraryEntry, "lastPageIndex" | "lastScrollTop">;

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
  };

  const db = await getAppDb();
  await db.put("pdfLibrary", updatedEntry);

  return updatedEntry;
}
