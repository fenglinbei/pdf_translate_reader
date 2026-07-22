import { requireSupabaseClient } from "../auth/supabaseClient";
import { requireCurrentUserId } from "../cloud/currentUser";
import type {
  MathpixDocumentRecord,
  MathpixParsedLine,
  MathpixParsedPage,
  MathpixParseStatus,
  PdfLibraryEntry,
} from "../types/domain";
import { MATHPIX_OPTIONS_HASH, MATHPIX_TEXT_SOURCE } from "./options";

const MATHPIX_BUCKET = "user-mathpix";
const DUPLICATE_KEY_ERROR_CODE = "23505";

export const CLOUD_MATHPIX_STALE_MS = 30 * 60 * 1000;

type CloudMathpixDocumentRow = {
  completed_at?: string | null;
  content_sha256: string;
  created_at: string;
  deleted_at?: string | null;
  delete_remote_after_cache?: boolean | null;
  error_message?: string | null;
  file_name: string;
  file_size: number;
  full_mmd_storage_path?: string | null;
  mathpix_options_hash: string;
  mathpix_pdf_id?: string | null;
  num_pages?: number | null;
  num_pages_completed?: number | null;
  pages_storage_path?: string | null;
  pdf_fingerprint: string;
  percent_done?: number | null;
  remote_deleted_at?: string | null;
  status: MathpixParseStatus;
  submitted_at?: string | null;
  updated_at: string;
  user_document_id: string;
  user_id: string;
};

type CloudMathpixClaim = {
  claimed: boolean;
  record?: MathpixDocumentRecord;
};

type CloudMathpixCache = {
  pages: MathpixParsedPage[];
  record: MathpixDocumentRecord;
};

const CLOUD_MATHPIX_COLUMNS = [
  "completed_at",
  "content_sha256",
  "created_at",
  "deleted_at",
  "delete_remote_after_cache",
  "error_message",
  "file_name",
  "file_size",
  "full_mmd_storage_path",
  "mathpix_options_hash",
  "mathpix_pdf_id",
  "num_pages",
  "num_pages_completed",
  "pages_storage_path",
  "pdf_fingerprint",
  "percent_done",
  "remote_deleted_at",
  "status",
  "submitted_at",
  "updated_at",
  "user_document_id",
  "user_id",
].join(",");

export function canUseCloudMathpixCache(
  entry: PdfLibraryEntry,
): entry is PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string } {
  return Boolean(entry.cloudDocumentId && entry.contentSha256);
}

export function isCloudMathpixRecordStale(record: MathpixDocumentRecord, now = Date.now()) {
  if (record.status !== "submitted" && record.status !== "processing") {
    return false;
  }

  return now - record.updatedAt > CLOUD_MATHPIX_STALE_MS;
}

export async function getCloudMathpixDocumentRecord(
  entry: PdfLibraryEntry,
  expectedUserId?: string,
) {
  if (!canUseCloudMathpixCache(entry)) {
    return undefined;
  }

  const userId = await requireCurrentUserId();
  assertExpectedUserId(userId, expectedUserId);
  return getCloudMathpixDocumentRecordForUser(entry, userId);
}

async function getCloudMathpixDocumentRecordForUser(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
  userId: string,
) {
  const { data, error } = await requireSupabaseClient()
    .from("user_mathpix_documents")
    .select(CLOUD_MATHPIX_COLUMNS)
    .eq("user_id", userId)
    .eq("content_sha256", entry.contentSha256)
    .eq("mathpix_options_hash", MATHPIX_OPTIONS_HASH)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? rowToMathpixRecord(data as unknown as CloudMathpixDocumentRow, entry) : undefined;
}

export async function claimCloudMathpixSubmission(
  entry: PdfLibraryEntry,
  expectedUserId?: string,
): Promise<CloudMathpixClaim> {
  if (!canUseCloudMathpixCache(entry)) {
    return { claimed: false };
  }

  const userId = await requireCurrentUserId();
  assertExpectedUserId(userId, expectedUserId);
  const existingRecord = await getCloudMathpixDocumentRecordForUser(entry, userId);

  if (existingRecord && !canReplaceCloudMathpixRecord(existingRecord)) {
    return { claimed: false, record: existingRecord };
  }

  if (existingRecord) {
    const record = createCloudPendingRecord(entry);
    const updatedRecord = await replaceCloudMathpixRecordIfStillEligible(
      entry,
      record,
      existingRecord,
      userId,
    );

    return {
      claimed: Boolean(updatedRecord),
      record: updatedRecord ?? await getCloudMathpixDocumentRecordForUser(entry, userId),
    };
  }

  const record = createCloudPendingRecord(entry);
  const { data, error } = await requireSupabaseClient()
    .from("user_mathpix_documents")
    .insert(toCloudRow(entry, record, userId))
    .select(CLOUD_MATHPIX_COLUMNS)
    .single();

  if (error) {
    if (getSupabaseErrorCode(error) === DUPLICATE_KEY_ERROR_CODE) {
      return {
        claimed: false,
        record: await getCloudMathpixDocumentRecordForUser(entry, userId),
      };
    }

    throw error;
  }

  return {
    claimed: true,
    record: rowToMathpixRecord(data as unknown as CloudMathpixDocumentRow, entry),
  };
}

export async function syncCloudMathpixDocumentRecord(
  entry: PdfLibraryEntry,
  record: MathpixDocumentRecord,
  expectedUserId?: string,
) {
  if (!canUseCloudMathpixCache(entry)) {
    return undefined;
  }

  const userId = await requireCurrentUserId();
  assertExpectedUserId(userId, expectedUserId);
  return syncCloudMathpixDocumentRecordForUser(entry, record, userId);
}

export async function backfillCloudMathpixProcessingRecord(
  entry: PdfLibraryEntry,
  record: MathpixDocumentRecord,
  expectedUserId?: string,
) {
  if (
    !canUseCloudMathpixCache(entry) ||
    !record.mathpixPdfId ||
    (
      record.status !== "submitted" &&
      record.status !== "processing" &&
      record.status !== "error"
    )
  ) {
    return undefined;
  }

  const userId = await requireCurrentUserId();
  assertExpectedUserId(userId, expectedUserId);
  const client = requireSupabaseClient();
  const row = toCloudRow(entry, record, userId);
  const matchActiveRecord = () => client
    .from("user_mathpix_documents")
    .update(row)
    .eq("user_id", userId)
    .eq("content_sha256", entry.contentSha256)
    .eq("mathpix_options_hash", MATHPIX_OPTIONS_HASH)
    .in("status", ["submitted", "processing"]);
  const { data: missingIdData, error: missingIdError } = await matchActiveRecord()
    .is("mathpix_pdf_id", null)
    .select(CLOUD_MATHPIX_COLUMNS)
    .maybeSingle();

  if (missingIdError) {
    throw missingIdError;
  }

  if (missingIdData) {
    return rowToMathpixRecord(missingIdData as unknown as CloudMathpixDocumentRow, entry);
  }

  const { data: sameIdData, error: sameIdError } = await matchActiveRecord()
    .eq("mathpix_pdf_id", record.mathpixPdfId)
    .lt("updated_at", new Date(record.updatedAt).toISOString())
    .select(CLOUD_MATHPIX_COLUMNS)
    .maybeSingle();

  if (sameIdError) {
    throw sameIdError;
  }

  if (sameIdData) {
    return rowToMathpixRecord(sameIdData as unknown as CloudMathpixDocumentRow, entry);
  }

  const { data: insertedData, error: insertError } = await client
    .from("user_mathpix_documents")
    .insert(row)
    .select(CLOUD_MATHPIX_COLUMNS)
    .single();

  if (insertError) {
    if (getSupabaseErrorCode(insertError) === DUPLICATE_KEY_ERROR_CODE) {
      return getCloudMathpixDocumentRecordForUser(entry, userId);
    }

    throw insertError;
  }

  return rowToMathpixRecord(insertedData as unknown as CloudMathpixDocumentRow, entry);
}

async function syncCloudMathpixDocumentRecordForUser(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
  record: MathpixDocumentRecord,
  userId: string,
) {
  const { data, error } = await requireSupabaseClient()
    .from("user_mathpix_documents")
    .upsert(toCloudRow(entry, record, userId), {
      onConflict: "user_id,content_sha256,mathpix_options_hash",
    })
    .select(CLOUD_MATHPIX_COLUMNS)
    .single();

  if (error) {
    throw error;
  }

  return rowToMathpixRecord(data as unknown as CloudMathpixDocumentRow, entry);
}

export async function downloadCompletedCloudMathpixCache(
  entry: PdfLibraryEntry,
  record: MathpixDocumentRecord,
): Promise<CloudMathpixCache | undefined> {
  if (!canUseCloudMathpixCache(entry) || record.status !== "completed" || !record.pagesStoragePath) {
    return undefined;
  }

  const pagesPayload = await downloadStorageJson(record.pagesStoragePath);
  const pages = normalizeStoredPages(pagesPayload, entry);

  const fullMmd = record.fullMmdStoragePath
    ? await downloadStorageText(record.fullMmdStoragePath).catch(() => record.fullMmd ?? "")
    : record.fullMmd;

  return {
    pages,
    record: {
      ...record,
      cloudDocumentId: entry.cloudDocumentId,
      contentSha256: entry.contentSha256,
      fileName: entry.fileName,
      fileSize: entry.fileSize,
      fullMmd,
      pdfFingerprint: entry.fingerprint,
    },
  };
}

export async function uploadCompletedCloudMathpixCache({
  entry,
  expectedUserId,
  fullMmd,
  pages,
  record,
}: {
  entry: PdfLibraryEntry;
  expectedUserId?: string;
  fullMmd?: string;
  pages: MathpixParsedPage[];
  record: MathpixDocumentRecord;
}) {
  if (!canUseCloudMathpixCache(entry)) {
    return undefined;
  }

  const userId = await requireCurrentUserId();
  assertExpectedUserId(userId, expectedUserId);
  const paths = getCloudMathpixStoragePaths(userId, entry);
  const normalizedPages = normalizeStoredPages(pages, entry);
  const pagesBlob = new Blob([JSON.stringify(normalizedPages)], { type: "application/json" });
  const fullMmdBlob = new Blob([fullMmd ?? ""], { type: "text/plain" });

  await uploadStorageObject(paths.pagesStoragePath, pagesBlob, "application/json");
  await uploadStorageObject(paths.fullMmdStoragePath, fullMmdBlob, "text/plain");

  const now = Date.now();

  const syncedRecord = await syncCloudMathpixDocumentRecordForUser(entry, {
    ...record,
    cloudMathpixSyncedAt: now,
    fullMmd,
    fullMmdStoragePath: paths.fullMmdStoragePath,
    pagesStoragePath: paths.pagesStoragePath,
    status: "completed",
    updatedAt: now,
  }, userId);

  return syncedRecord
    ? {
        ...syncedRecord,
        cloudMathpixSyncedAt: now,
        fullMmd,
        fullMmdStoragePath: paths.fullMmdStoragePath,
        pagesStoragePath: paths.pagesStoragePath,
      }
    : undefined;
}

export async function deleteCloudMathpixCacheByDocument(
  cloudDocumentId: string | undefined,
  contentSha256?: string,
) {
  if (!cloudDocumentId) {
    return;
  }

  const userId = await requireCurrentUserId();
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_mathpix_documents")
    .select("pages_storage_path,full_mmd_storage_path")
    .eq("user_id", userId)
    .eq("user_document_id", cloudDocumentId);

  if (error) {
    throw error;
  }

  let hasAnotherActiveDocument = false;

  if (contentSha256) {
    const { data: activeDocument, error: activeDocumentError } = await client
      .from("user_documents")
      .select("id")
      .eq("user_id", userId)
      .eq("content_sha256", contentSha256)
      .neq("id", cloudDocumentId)
      .is("deleted_at", null)
      .maybeSingle();

    if (activeDocumentError) {
      throw activeDocumentError;
    }

    hasAnotherActiveDocument = Boolean(activeDocument);
  }

  if (hasAnotherActiveDocument) {
    return;
  }

  const rows = (data ?? []) as unknown as Array<{
    full_mmd_storage_path?: string | null;
    pages_storage_path?: string | null;
  }>;
  const deterministicPaths = contentSha256
    ? Object.values(getCloudMathpixStoragePaths(userId, { contentSha256 }))
    : [];
  const storagePaths = Array.from(new Set(
    [
      ...deterministicPaths,
      ...rows.flatMap((row) => [
        row.pages_storage_path,
        row.full_mmd_storage_path,
      ]),
    ].filter((path): path is string => Boolean(path)),
  ));

  if (storagePaths.length > 0) {
    const { error: storageError } = await client.storage
      .from(MATHPIX_BUCKET)
      .remove(storagePaths);

    if (storageError) {
      throw storageError;
    }
  }

  const { error: deleteError } = await client
    .from("user_mathpix_documents")
    .delete()
    .eq("user_id", userId)
    .eq("user_document_id", cloudDocumentId);

  if (deleteError) {
    throw deleteError;
  }
}

async function replaceCloudMathpixRecordIfStillEligible(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
  record: MathpixDocumentRecord,
  existingRecord: MathpixDocumentRecord,
  userId: string,
) {
  let updateQuery = requireSupabaseClient()
    .from("user_mathpix_documents")
    .update(toCloudRow(entry, record, userId))
    .eq("user_id", userId)
    .eq("content_sha256", entry.contentSha256)
    .eq("mathpix_options_hash", MATHPIX_OPTIONS_HASH);

  if (existingRecord.status === "error" || existingRecord.status === "deleted") {
    updateQuery = updateQuery.in("status", ["error", "deleted"]);
  } else if (existingRecord.status === "completed") {
    updateQuery = updateQuery
      .eq("status", "completed")
      .is("pages_storage_path", null);
  } else {
    updateQuery = updateQuery
      .in("status", ["submitted", "processing"])
      .lt("updated_at", new Date(Date.now() - CLOUD_MATHPIX_STALE_MS).toISOString());
  }

  const { data, error } = await updateQuery
    .select(CLOUD_MATHPIX_COLUMNS)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? rowToMathpixRecord(data as unknown as CloudMathpixDocumentRow, entry) : undefined;
}

function createCloudPendingRecord(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
): MathpixDocumentRecord {
  const now = Date.now();

  return {
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
}

function canReplaceCloudMathpixRecord(record: MathpixDocumentRecord) {
  return (
    record.status === "error" ||
    record.status === "deleted" ||
    (record.status === "completed" && !record.pagesStoragePath) ||
    isCloudMathpixRecordStale(record)
  );
}

function getCloudMathpixStoragePaths(
  userId: string,
  entry: { contentSha256: string },
) {
  const basePath = `${userId}/${entry.contentSha256}/${MATHPIX_OPTIONS_HASH}`;

  return {
    fullMmdStoragePath: `${basePath}/full.mmd`,
    pagesStoragePath: `${basePath}/pages.json`,
  };
}

function assertExpectedUserId(userId: string, expectedUserId: string | undefined) {
  if (expectedUserId && userId !== expectedUserId) {
    throw new DOMException("The signed-in user changed during MathPix sync.", "AbortError");
  }
}

function toCloudRow(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
  record: MathpixDocumentRecord,
  userId: string,
) {
  return {
    completed_at: toOptionalIso(record.completedAt),
    content_sha256: entry.contentSha256,
    deleted_at: record.status === "deleted" ? new Date(record.updatedAt).toISOString() : null,
    delete_remote_after_cache: record.deleteRemoteAfterCache ?? null,
    error_message: record.errorMessage ?? null,
    file_name: entry.fileName,
    file_size: entry.fileSize,
    full_mmd_storage_path: record.fullMmdStoragePath ?? null,
    mathpix_options_hash: MATHPIX_OPTIONS_HASH,
    mathpix_pdf_id: record.mathpixPdfId ?? null,
    num_pages: record.numPages ?? null,
    num_pages_completed: record.numPagesCompleted ?? null,
    pages_storage_path: record.pagesStoragePath ?? null,
    pdf_fingerprint: entry.fingerprint,
    percent_done: record.percentDone ?? null,
    remote_deleted_at: toOptionalIso(record.remoteDeletedAt),
    status: record.status,
    submitted_at: toOptionalIso(record.submittedAt),
    updated_at: new Date(record.updatedAt).toISOString(),
    user_document_id: entry.cloudDocumentId,
    user_id: userId,
  };
}

function rowToMathpixRecord(
  row: CloudMathpixDocumentRow,
  entry?: PdfLibraryEntry,
): MathpixDocumentRecord {
  return {
    cloudDocumentId: entry?.cloudDocumentId ?? row.user_document_id,
    completedAt: parseIsoTime(row.completed_at),
    contentSha256: entry?.contentSha256 ?? row.content_sha256,
    deleteRemoteAfterCache: row.delete_remote_after_cache ?? undefined,
    errorMessage: row.error_message ?? undefined,
    fileName: entry?.fileName ?? row.file_name,
    fileSize: entry?.fileSize ?? Number(row.file_size),
    fullMmdStoragePath: row.full_mmd_storage_path ?? undefined,
    mathpixOptionsHash: row.mathpix_options_hash,
    mathpixPdfId: row.mathpix_pdf_id ?? undefined,
    numPages: row.num_pages ?? undefined,
    numPagesCompleted: row.num_pages_completed ?? undefined,
    pagesStoragePath: row.pages_storage_path ?? undefined,
    pdfFingerprint: entry?.fingerprint ?? row.pdf_fingerprint,
    percentDone: row.percent_done ?? undefined,
    remoteDeletedAt: parseIsoTime(row.remote_deleted_at),
    status: row.status,
    submittedAt: parseIsoTime(row.submitted_at),
    updatedAt: parseIsoTime(row.updated_at) ?? Date.now(),
  };
}

async function uploadStorageObject(path: string, body: Blob, contentType: string) {
  const { error } = await requireSupabaseClient().storage
    .from(MATHPIX_BUCKET)
    .upload(path, body, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw error;
  }
}

async function downloadStorageJson(path: string) {
  const { data, error } = await requireSupabaseClient().storage
    .from(MATHPIX_BUCKET)
    .download(path);

  if (error) {
    throw error;
  }

  return JSON.parse(await data.text()) as unknown;
}

async function downloadStorageText(path: string) {
  const { data, error } = await requireSupabaseClient().storage
    .from(MATHPIX_BUCKET)
    .download(path);

  if (error) {
    throw error;
  }

  return data.text();
}

function normalizeStoredPages(value: unknown, entry: PdfLibraryEntry): MathpixParsedPage[] {
  if (!Array.isArray(value)) {
    throw new Error("Cloud MathPix pages cache is not an array.");
  }

  const now = Date.now();

  return value
    .map((page, fallbackPageIndex) => normalizeStoredPage(page, entry, fallbackPageIndex, now))
    .filter((page): page is MathpixParsedPage => Boolean(page && page.lines.length > 0))
    .sort((left, right) => left.pageIndex - right.pageIndex);
}

function normalizeStoredPage(
  value: unknown,
  entry: PdfLibraryEntry,
  fallbackPageIndex: number,
  now: number,
): MathpixParsedPage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const lines = Array.isArray(value.lines) ? value.lines as MathpixParsedLine[] : [];
  const pageText = typeof value.pageText === "string" ? value.pageText : "";
  const pageMmd = typeof value.pageMmd === "string" ? value.pageMmd : pageText;

  return {
    cloudDocumentId: entry.cloudDocumentId,
    lineCount: typeof value.lineCount === "number" ? value.lineCount : lines.length,
    lines,
    mathpixOptionsHash: MATHPIX_OPTIONS_HASH,
    minConfidence: typeof value.minConfidence === "number" ? value.minConfidence : undefined,
    pageHeight: typeof value.pageHeight === "number" ? value.pageHeight : undefined,
    pageIndex: typeof value.pageIndex === "number" ? value.pageIndex : fallbackPageIndex,
    pageMmd,
    pageText,
    pageWidth: typeof value.pageWidth === "number" ? value.pageWidth : undefined,
    pdfFingerprint: entry.fingerprint,
    source: MATHPIX_TEXT_SOURCE,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
  };
}

function parseIsoTime(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function toOptionalIso(epochMs: number | undefined) {
  return typeof epochMs === "number" ? new Date(epochMs).toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function getSupabaseErrorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
