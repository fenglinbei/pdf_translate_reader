import type {
  CloudPdfLibraryEntry,
  PdfFingerprint,
  PdfLibraryEntry,
  PdfMetadata,
} from "../types/domain";
import {
  deletePdfLocalData,
  getPdfLibraryEntry,
  saveImportedPdf,
  updatePdfReadingPosition,
  type ReadingPositionUpdate,
} from "../cache/pdfLibraryRepository";
import { requireSupabaseClient } from "../auth/supabaseClient";
import { requireCurrentUserId } from "./currentUser";
import { deleteCloudDocumentState } from "./documentStateRepository";

const PDF_BUCKET = "user-pdfs";

type UserDocumentRow = {
  content_sha256: string;
  deleted_at?: string | null;
  display_file_name: string;
  file_size: number;
  id: string;
  imported_at: string;
  last_opened_at: string;
  last_page_index?: number | null;
  last_scroll_top?: number | null;
  last_zoom?: number | null;
  mime_type: "application/pdf";
  open_count: number;
  pdf_fingerprint: string;
  pdf_metadata?: PdfMetadata | null;
  storage_path: string;
  user_id: string;
};

export async function listCloudPdfLibraryEntries() {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .select(getUserDocumentColumns())
    .is("deleted_at", null)
    .order("display_file_name", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as unknown as UserDocumentRow[];

  return Promise.all(rows.map(mapCloudLibraryEntryWithCacheState));
}

export async function importPdfToCloud(
  file: File,
  identity: PdfFingerprint,
): Promise<PdfLibraryEntry> {
  const client = requireSupabaseClient();
  const userId = await requireCurrentUserId();
  const existingRow = await findActiveUserDocumentByContentHash(identity.contentSha256);
  const blob = file.slice(0, file.size, "application/pdf");

  if (existingRow) {
    const updatedRow = await updateUserDocument(existingRow.id, {
      display_file_name: identity.fileName,
      file_size: identity.fileSize,
      last_opened_at: new Date().toISOString(),
      mime_type: "application/pdf",
      open_count: existingRow.open_count + 1,
      pdf_fingerprint: identity.fingerprint,
      pdf_metadata: identity.pdfMetadata ?? null,
    });

    return saveCloudPdfLocalCache(blob, identity, updatedRow);
  }

  const storagePath = `${userId}/${identity.contentSha256}.pdf`;
  const uploadResult = await client.storage
    .from(PDF_BUCKET)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: "application/pdf",
      upsert: true,
    });

  if (uploadResult.error) {
    throw uploadResult.error;
  }

  const now = new Date().toISOString();
  const { data, error } = await client
    .from("user_documents")
    .insert({
      content_sha256: identity.contentSha256,
      display_file_name: identity.fileName,
      file_size: identity.fileSize,
      imported_at: now,
      last_opened_at: now,
      mime_type: "application/pdf",
      open_count: 1,
      pdf_fingerprint: identity.fingerprint,
      pdf_metadata: identity.pdfMetadata ?? null,
      storage_path: storagePath,
      user_id: userId,
    })
    .select(getUserDocumentColumns())
    .single();

  if (error) {
    throw error;
  }

  return saveCloudPdfLocalCache(blob, identity, data as unknown as UserDocumentRow);
}

export async function openCloudPdfDocument(documentId: string): Promise<PdfLibraryEntry> {
  const row = await getCloudDocumentRow(documentId);
  const openedRow = await updateUserDocument(row.id, {
    last_opened_at: new Date().toISOString(),
    open_count: row.open_count + 1,
  });
  const localEntry = await getPdfLibraryEntry(openedRow.pdf_fingerprint);

  if (localEntry?.blob instanceof Blob) {
    return saveCloudPdfLocalCache(localEntry.blob, rowToFingerprint(openedRow), openedRow);
  }

  const client = requireSupabaseClient();
  const { data, error } = await client.storage
    .from(PDF_BUCKET)
    .download(openedRow.storage_path);

  if (error) {
    throw error;
  }

  return saveCloudPdfLocalCache(data, rowToFingerprint(openedRow), openedRow);
}

export async function deleteCloudPdfDocument(documentId: string) {
  const row = await getCloudDocumentRow(documentId);
  const client = requireSupabaseClient();

  await deleteCloudDocumentState(documentId);

  const { error: updateError } = await client
    .from("user_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", documentId);

  if (updateError) {
    throw updateError;
  }

  const { error: storageError } = await client.storage
    .from(PDF_BUCKET)
    .remove([row.storage_path]);

  if (storageError) {
    throw storageError;
  }

  await deletePdfLocalData(row.pdf_fingerprint);
}

export async function updateCloudReadingPosition(
  documentId: string,
  position: ReadingPositionUpdate,
) {
  const row = await updateUserDocument(documentId, {
    last_page_index: position.lastPageIndex ?? null,
    last_scroll_top: position.lastScrollTop ?? null,
    last_zoom: position.lastZoom ?? null,
  });

  await updatePdfReadingPosition(row.pdf_fingerprint, position);

  return mapCloudLibraryEntryWithCacheState(row);
}

async function findActiveUserDocumentByContentHash(contentSha256: string) {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .select(getUserDocumentColumns())
    .eq("content_sha256", contentSha256)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as unknown as UserDocumentRow | null;
}

async function getCloudDocumentRow(documentId: string) {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .select(getUserDocumentColumns())
    .eq("id", documentId)
    .is("deleted_at", null)
    .single();

  if (error) {
    throw error;
  }

  return data as unknown as UserDocumentRow;
}

async function updateUserDocument(
  documentId: string,
  values: Record<string, unknown>,
) {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .update(values)
    .eq("id", documentId)
    .select(getUserDocumentColumns())
    .single();

  if (error) {
    throw error;
  }

  return data as unknown as UserDocumentRow;
}

async function saveCloudPdfLocalCache(
  blob: Blob,
  identity: PdfFingerprint,
  row: UserDocumentRow,
) {
  const entry = await saveImportedPdf({
    blob,
    cloudDocumentId: row.id,
    contentSha256: row.content_sha256,
    fileName: row.display_file_name || identity.fileName,
    fileSize: row.file_size || identity.fileSize,
    fingerprint: row.pdf_fingerprint || identity.fingerprint,
    modifiedAt: identity.modifiedAt,
    pdfMetadata: row.pdf_metadata ?? identity.pdfMetadata,
    storagePath: row.storage_path,
  });

  if (
    typeof row.last_page_index === "number" ||
    typeof row.last_scroll_top === "number" ||
    typeof row.last_zoom === "number"
  ) {
    const updatedEntry = await updatePdfReadingPosition(entry.fingerprint, {
      lastPageIndex: row.last_page_index ?? undefined,
      lastScrollTop: row.last_scroll_top ?? undefined,
      lastZoom: row.last_zoom ?? undefined,
    });

    return updatedEntry ? mergeCloudFields(updatedEntry, row) : mergeCloudFields(entry, row);
  }

  return mergeCloudFields(entry, row);
}

async function mapCloudLibraryEntryWithCacheState(row: UserDocumentRow) {
  const localEntry = await getPdfLibraryEntry(row.pdf_fingerprint);

  return {
    ...mapCloudLibraryEntry(row),
    localCached: Boolean(localEntry?.blob instanceof Blob),
  };
}

function mapCloudLibraryEntry(row: UserDocumentRow): CloudPdfLibraryEntry {
  return {
    cloudDocumentId: row.id,
    contentSha256: row.content_sha256,
    deletedAt: row.deleted_at ? Date.parse(row.deleted_at) : undefined,
    fileName: row.display_file_name,
    fileSize: row.file_size,
    fingerprint: row.pdf_fingerprint,
    importedAt: Date.parse(row.imported_at),
    lastOpenedAt: Date.parse(row.last_opened_at),
    lastPageIndex: row.last_page_index ?? undefined,
    lastScrollTop: row.last_scroll_top ?? undefined,
    lastZoom: row.last_zoom ?? undefined,
    mimeType: row.mime_type,
    openCount: row.open_count,
    pdfMetadata: row.pdf_metadata ?? undefined,
    storagePath: row.storage_path,
  };
}

function mergeCloudFields(entry: PdfLibraryEntry, row: UserDocumentRow): PdfLibraryEntry {
  return {
    ...entry,
    cloudDocumentId: row.id,
    contentSha256: row.content_sha256,
    fileName: row.display_file_name || entry.fileName,
    fileSize: row.file_size || entry.fileSize,
    importedAt: Date.parse(row.imported_at),
    lastOpenedAt: Date.parse(row.last_opened_at),
    lastPageIndex: row.last_page_index ?? entry.lastPageIndex,
    lastScrollTop: row.last_scroll_top ?? entry.lastScrollTop,
    lastZoom: row.last_zoom ?? entry.lastZoom,
    openCount: row.open_count,
    pdfMetadata: row.pdf_metadata ?? entry.pdfMetadata,
    storagePath: row.storage_path,
  };
}

function rowToFingerprint(row: UserDocumentRow): PdfFingerprint {
  return {
    contentSha256: row.content_sha256,
    fileName: row.display_file_name,
    fileSize: row.file_size,
    pdfMetadata: row.pdf_metadata ?? undefined,
    fingerprint: row.pdf_fingerprint,
  };
}

function getUserDocumentColumns() {
  return [
    "content_sha256",
    "deleted_at",
    "display_file_name",
    "file_size",
    "id",
    "imported_at",
    "last_opened_at",
    "last_page_index",
    "last_scroll_top",
    "last_zoom",
    "mime_type",
    "open_count",
    "pdf_fingerprint",
    "pdf_metadata",
    "storage_path",
    "user_id",
  ].join(",");
}
