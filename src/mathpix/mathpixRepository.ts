import { getAppDb } from "../cache";
import type {
  MathpixDocumentRecord,
  MathpixParsedPage,
  PdfLibraryEntry,
} from "../types/domain";
import { MATHPIX_OPTIONS_HASH } from "./options";

export async function getMathpixDocumentRecord(pdfFingerprint: string) {
  const db = await getAppDb();

  return db.get("mathpixDocuments", pdfFingerprint);
}

export async function putMathpixDocumentRecord(record: MathpixDocumentRecord) {
  const db = await getAppDb();

  await db.put("mathpixDocuments", record);

  return record;
}

export async function createPendingMathpixDocumentRecord(entry: PdfLibraryEntry) {
  const now = Date.now();
  const record: MathpixDocumentRecord = {
    cloudDocumentId: entry.cloudDocumentId,
    contentSha256: entry.contentSha256,
    fileName: entry.fileName,
    fileSize: entry.fileSize,
    mathpixOptionsHash: MATHPIX_OPTIONS_HASH,
    pdfFingerprint: entry.fingerprint,
    status: "submitted",
    submittedAt: now,
    updatedAt: now,
  };

  return putMathpixDocumentRecord(record);
}

export async function listMathpixParsedPages(pdfFingerprint: string) {
  const db = await getAppDb();
  const pages = await db.getAllFromIndex("mathpixParsedPages", "by-pdf", pdfFingerprint);

  return pages.sort((left, right) => left.pageIndex - right.pageIndex);
}

export async function replaceMathpixParsedPages(
  pdfFingerprint: string,
  pages: MathpixParsedPage[],
) {
  const db = await getAppDb();
  const existingKeys = await db.getAllKeysFromIndex("mathpixParsedPages", "by-pdf", pdfFingerprint);
  const transaction = db.transaction("mathpixParsedPages", "readwrite");
  const store = transaction.objectStore("mathpixParsedPages");

  for (const key of existingKeys) {
    await store.delete(key);
  }

  for (const page of pages) {
    await store.put(page);
  }

  await transaction.done;
}

export function mapPagesByIndex(pages: MathpixParsedPage[]) {
  return new Map(pages.map((page) => [page.pageIndex, page]));
}

export function isCompletedCurrentMathpixRecord(
  record: MathpixDocumentRecord | undefined,
  entry: PdfLibraryEntry,
) {
  return Boolean(
    record &&
      record.status === "completed" &&
      record.mathpixOptionsHash === MATHPIX_OPTIONS_HASH &&
      (!entry.contentSha256 || !record.contentSha256 || entry.contentSha256 === record.contentSha256),
  );
}
