import type {
  BibliographicMetadata,
  CloudPdfLibraryEntry,
  LibraryCollection,
  LibraryCollectionCreateInput,
  LibraryCollectionUpdateInput,
  LibraryDocument,
  LibraryDocumentBatchUpdate,
  LibraryDocumentMetadataPatch,
  LibraryDocumentOrganizationUpdate,
  LibraryDocumentPage,
  LibraryDocumentQuery,
  LibraryReadingStatus,
  LibraryTag,
  LibraryTagCreateInput,
  LibraryTagUpdateInput,
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
  abstract?: string | null;
  archived_at?: string | null;
  arxiv_id?: string | null;
  authors?: string[] | null;
  content_sha256: string;
  deleted_at?: string | null;
  display_file_name: string;
  doi?: string | null;
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
  publication_venue?: string | null;
  publication_year?: number | null;
  reading_status?: string | null;
  starred_at?: string | null;
  storage_path: string;
  title?: string | null;
  library_updated_at?: string | null;
  user_id: string;
};

type LibraryCollectionRow = {
  color?: string | null;
  created_at: string;
  description?: string | null;
  id: string;
  name: string;
  parent_id?: string | null;
  sort_order: number;
  updated_at: string;
  user_id?: string;
};

type LibraryTagRow = {
  color?: string | null;
  created_at: string;
  id: string;
  name: string;
  updated_at: string;
  user_id?: string;
};

type LibraryDocumentSearchRow = UserDocumentRow & {
  collections?: LibraryCollectionRow[] | null;
  tags?: LibraryTagRow[] | null;
};

type LibrarySearchPayload = {
  items?: LibraryDocumentSearchRow[];
  total?: number;
  limit?: number;
  offset?: number;
};

export async function listCloudPdfLibraryEntries() {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .select(getUserDocumentColumns())
    .is("deleted_at", null)
    .is("archived_at", null)
    .order("display_file_name", { ascending: true });

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as unknown as UserDocumentRow[];

  return Promise.all(rows.map(mapCloudLibraryEntryWithCacheState));
}

export async function listLibraryDocuments(
  query: LibraryDocumentQuery = {},
): Promise<LibraryDocumentPage> {
  const client = requireSupabaseClient();
  const limit = clampInteger(query.limit, 1, 100, 50);
  const offset = clampInteger(query.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const { data, error } = await client.rpc("search_user_library_documents", {
    p_archived: query.archiveMode === "all"
      ? null
      : query.archiveMode === "archived",
    p_collection_ids: normalizeIds(query.collectionIds),
    p_limit: limit,
    p_offset: offset,
    p_query: normalizeOptionalText(query.query),
    p_reading_statuses: normalizeReadingStatuses(query.readingStatuses),
    p_sort: query.sort ?? "updated-desc",
    p_starred: query.starred ?? null,
    p_tag_ids: normalizeIds(query.tagIds),
    p_uncategorized: query.uncategorized ?? false,
    p_year_from: normalizeYear(query.yearFrom),
    p_year_to: normalizeYear(query.yearTo),
  });

  if (error) {
    throw error;
  }

  const payload = (data ?? {}) as unknown as LibrarySearchPayload;
  const items = await Promise.all(
    (payload.items ?? []).map(mapLibraryDocumentWithCacheState),
  );

  return {
    items,
    total: normalizeNonNegativeInteger(payload.total, 0),
    limit: normalizePositiveInteger(payload.limit, limit),
    offset: normalizeNonNegativeInteger(payload.offset, offset),
  };
}

export async function getLibraryDocument(documentId: string): Promise<LibraryDocument> {
  const row = await getCloudDocumentRow(documentId);
  const [collections, tags, localEntry] = await Promise.all([
    listDocumentCollections(documentId),
    listDocumentTags(documentId),
    getPdfLibraryEntry(row.pdf_fingerprint),
  ]);

  return mapLibraryDocument(
    row,
    collections,
    tags,
    Boolean(localEntry?.blob instanceof Blob),
  );
}

export async function updateLibraryDocumentMetadata(
  documentId: string,
  patch: LibraryDocumentMetadataPatch,
): Promise<LibraryDocument> {
  const values = mapLibraryDocumentPatch(patch);

  if (Object.keys(values).length > 0) {
    await updateUserDocument(documentId, values);
  }

  return getLibraryDocument(documentId);
}

export async function saveLibraryDocument(
  documentId: string,
  patch: LibraryDocumentMetadataPatch,
  organization: Required<LibraryDocumentOrganizationUpdate>,
): Promise<LibraryDocument> {
  const client = requireSupabaseClient();
  const { error } = await client.rpc("save_user_library_document", {
    p_abstract: normalizeOptionalText(patch.abstract),
    p_arxiv_id: normalizeOptionalText(patch.arxivId),
    p_authors: normalizeAuthors(patch.authors ?? []),
    p_collection_ids: normalizeIds(organization.collectionIds) ?? [],
    p_document_id: documentId,
    p_doi: normalizeOptionalText(patch.doi),
    p_publication_venue: normalizeOptionalText(patch.publicationVenue),
    p_publication_year: normalizeYear(patch.publicationYear),
    p_reading_status: patch.readingStatus ?? null,
    p_tag_ids: normalizeIds(organization.tagIds) ?? [],
    p_title: normalizeOptionalText(patch.title),
  });

  if (error) {
    throw error;
  }

  return getLibraryDocument(documentId);
}

export async function batchUpdateLibraryDocuments(
  input: LibraryDocumentBatchUpdate,
): Promise<LibraryDocument[]> {
  const documentIds = requireIds(input.documentIds, "documentIds");
  const client = requireSupabaseClient();
  const { error } = await client.rpc("batch_update_user_library_documents", {
    p_add_collection_ids: normalizeIds(input.addCollectionIds),
    p_add_tag_ids: normalizeIds(input.addTagIds),
    p_archived: input.archived ?? null,
    p_document_ids: documentIds,
    p_reading_status: input.readingStatus ?? null,
    p_remove_collection_ids: normalizeIds(input.removeCollectionIds),
    p_remove_tag_ids: normalizeIds(input.removeTagIds),
    p_starred: input.starred ?? null,
  });

  if (error) {
    throw error;
  }

  return Promise.all(documentIds.map(getLibraryDocument));
}

export function archiveLibraryDocument(documentId: string) {
  return updateLibraryDocumentMetadata(documentId, { archived: true });
}

export function restoreLibraryDocument(documentId: string) {
  return updateLibraryDocumentMetadata(documentId, { archived: false });
}

export async function listLibraryCollections(): Promise<LibraryCollection[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_collections")
    .select(getLibraryCollectionColumns())
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as LibraryCollectionRow[]).map(
    mapLibraryCollection,
  );
}

export async function createLibraryCollection(
  input: LibraryCollectionCreateInput,
): Promise<LibraryCollection> {
  const client = requireSupabaseClient();
  const userId = await requireCurrentUserId();
  const name = requireNonEmptyText(input.name, "Collection name");
  const { data, error } = await client
    .from("user_collections")
    .insert({
      color: normalizeOptionalText(input.color),
      description: normalizeOptionalText(input.description),
      name,
      parent_id: normalizeOptionalText(input.parentId),
      sort_order: normalizeInteger(input.sortOrder, 0),
      user_id: userId,
    })
    .select(getLibraryCollectionColumns())
    .single();

  if (error) {
    throw error;
  }

  return mapLibraryCollection(data as unknown as LibraryCollectionRow);
}

export async function updateLibraryCollection(
  collectionId: string,
  input: LibraryCollectionUpdateInput,
): Promise<LibraryCollection> {
  const client = requireSupabaseClient();
  const values: Record<string, unknown> = {};

  if (input.name !== undefined) {
    values.name = requireNonEmptyText(input.name, "Collection name");
  }
  if (input.description !== undefined) {
    values.description = normalizeOptionalText(input.description);
  }
  if (input.color !== undefined) {
    values.color = normalizeOptionalText(input.color);
  }
  if (input.parentId !== undefined) {
    values.parent_id = normalizeOptionalText(input.parentId);
  }
  if (input.sortOrder !== undefined) {
    values.sort_order = normalizeInteger(input.sortOrder, 0);
  }

  const { data, error } = Object.keys(values).length > 0
    ? await client
      .from("user_collections")
      .update(values)
      .eq("id", collectionId)
      .select(getLibraryCollectionColumns())
      .single()
    : await client
      .from("user_collections")
      .select(getLibraryCollectionColumns())
      .eq("id", collectionId)
      .single();

  if (error) {
    throw error;
  }

  return mapLibraryCollection(data as unknown as LibraryCollectionRow);
}

export async function deleteLibraryCollection(collectionId: string) {
  const client = requireSupabaseClient();
  const { error } = await client
    .from("user_collections")
    .delete()
    .eq("id", collectionId);

  if (error) {
    throw error;
  }
}

export async function listLibraryTags(): Promise<LibraryTag[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_tags")
    .select(getLibraryTagColumns())
    .order("name", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as LibraryTagRow[]).map(mapLibraryTag);
}

export async function createLibraryTag(
  input: LibraryTagCreateInput,
): Promise<LibraryTag> {
  const client = requireSupabaseClient();
  const userId = await requireCurrentUserId();
  const { data, error } = await client
    .from("user_tags")
    .insert({
      color: normalizeOptionalText(input.color),
      name: requireNonEmptyText(input.name, "Tag name"),
      user_id: userId,
    })
    .select(getLibraryTagColumns())
    .single();

  if (error) {
    throw error;
  }

  return mapLibraryTag(data as unknown as LibraryTagRow);
}

export async function updateLibraryTag(
  tagId: string,
  input: LibraryTagUpdateInput,
): Promise<LibraryTag> {
  const client = requireSupabaseClient();
  const values: Record<string, unknown> = {};

  if (input.name !== undefined) {
    values.name = requireNonEmptyText(input.name, "Tag name");
  }
  if (input.color !== undefined) {
    values.color = normalizeOptionalText(input.color);
  }

  const { data, error } = Object.keys(values).length > 0
    ? await client
      .from("user_tags")
      .update(values)
      .eq("id", tagId)
      .select(getLibraryTagColumns())
      .single()
    : await client
      .from("user_tags")
      .select(getLibraryTagColumns())
      .eq("id", tagId)
      .single();

  if (error) {
    throw error;
  }

  return mapLibraryTag(data as unknown as LibraryTagRow);
}

export async function deleteLibraryTag(tagId: string) {
  const client = requireSupabaseClient();
  const { error } = await client
    .from("user_tags")
    .delete()
    .eq("id", tagId);

  if (error) {
    throw error;
  }
}

export async function setDocumentCollections(
  documentId: string,
  collectionIds: string[],
): Promise<LibraryCollection[]> {
  await setDocumentOrganization(documentId, { collectionIds });

  return listDocumentCollections(documentId);
}

export async function setDocumentTags(
  documentId: string,
  tagIds: string[],
): Promise<LibraryTag[]> {
  await setDocumentOrganization(documentId, { tagIds });

  return listDocumentTags(documentId);
}

export async function setDocumentOrganization(
  documentId: string,
  input: LibraryDocumentOrganizationUpdate,
): Promise<void> {
  const client = requireSupabaseClient();
  const { error } = await client.rpc("set_user_document_organization", {
    p_collection_ids: input.collectionIds === undefined
      ? null
      : normalizeIds(input.collectionIds) ?? [],
    p_document_id: documentId,
    p_tag_ids: input.tagIds === undefined
      ? null
      : normalizeIds(input.tagIds) ?? [],
  });

  if (error) {
    throw error;
  }
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
      archived_at: null,
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
  const bibliographicMetadata = createDefaultBibliographicMetadata(identity);
  const { data, error } = await client
    .from("user_documents")
    .insert({
      authors: bibliographicMetadata.authors,
      content_sha256: identity.contentSha256,
      display_file_name: identity.fileName,
      file_size: identity.fileSize,
      imported_at: now,
      last_opened_at: now,
      mime_type: "application/pdf",
      open_count: 1,
      pdf_fingerprint: identity.fingerprint,
      pdf_metadata: identity.pdfMetadata ?? null,
      reading_status: "inbox",
      storage_path: storagePath,
      title: bibliographicMetadata.title ?? null,
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

  if (localEntry?.blob instanceof Blob && await canReadBlob(localEntry.blob)) {
    return saveCloudPdfLocalCache(localEntry.blob, rowToFingerprint(openedRow), openedRow);
  }

  const client = requireSupabaseClient();
  const { data, error } = await client.storage
    .from(PDF_BUCKET)
    .download(openedRow.storage_path);

  if (error) {
    throw error;
  }

  return saveCloudPdfLocalCache(data, rowToFingerprint(openedRow), openedRow, { replaceBlob: true });
}

export async function deleteCloudPdfDocument(documentId: string) {
  const row = await getCloudDocumentRowForDeletion(documentId);
  const client = requireSupabaseClient();

  if (!row.deleted_at) {
    const { error: updateError } = await client
      .from("user_documents")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", documentId)
      .is("deleted_at", null);

    if (updateError) {
      throw updateError;
    }
  }

  await deleteCloudDocumentState(documentId, row.content_sha256);

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

async function getCloudDocumentRowForDeletion(documentId: string) {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_documents")
    .select(getUserDocumentColumns())
    .eq("id", documentId)
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

async function listDocumentCollections(
  documentId: string,
): Promise<LibraryCollection[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_document_collections")
    .select("collection:user_collections(*)")
    .eq("user_document_id", documentId);

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((item) => {
      const relation = item as unknown as {
        collection?: LibraryCollectionRow | LibraryCollectionRow[] | null;
      };
      const row = Array.isArray(relation.collection)
        ? relation.collection[0]
        : relation.collection;
      return row ? mapLibraryCollection(row) : undefined;
    })
    .filter((collection): collection is LibraryCollection => Boolean(collection))
    .sort(compareLibraryCollections);
}

async function listDocumentTags(documentId: string): Promise<LibraryTag[]> {
  const client = requireSupabaseClient();
  const { data, error } = await client
    .from("user_document_tags")
    .select("tag:user_tags(*)")
    .eq("user_document_id", documentId);

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((item) => {
      const relation = item as unknown as {
        tag?: LibraryTagRow | LibraryTagRow[] | null;
      };
      const row = Array.isArray(relation.tag) ? relation.tag[0] : relation.tag;
      return row ? mapLibraryTag(row) : undefined;
    })
    .filter((tag): tag is LibraryTag => Boolean(tag))
    .sort(compareLibraryTags);
}

async function saveCloudPdfLocalCache(
  blob: Blob,
  identity: PdfFingerprint,
  row: UserDocumentRow,
  options: { replaceBlob?: boolean } = {},
) {
  const entry = await saveImportedPdf({
    blob,
    cloudDocumentId: row.id,
    contentSha256: row.content_sha256,
    fileName: row.display_file_name || identity.fileName,
    fileSize: row.file_size || identity.fileSize,
    fingerprint: row.pdf_fingerprint || identity.fingerprint,
    modifiedAt: identity.modifiedAt,
    pdfMetadata: getEffectivePdfMetadata(row, identity.pdfMetadata),
    replaceBlob: options.replaceBlob,
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

async function canReadBlob(blob: Blob) {
  try {
    await blob.slice(0, Math.min(blob.size, 1)).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function mapCloudLibraryEntryWithCacheState(row: UserDocumentRow) {
  const localEntry = await getPdfLibraryEntry(row.pdf_fingerprint);

  return {
    ...mapCloudLibraryEntry(row),
    localCached: Boolean(localEntry?.blob instanceof Blob),
  };
}

function mapCloudLibraryEntry(row: UserDocumentRow): CloudPdfLibraryEntry {
  const bibliographicMetadata = mapBibliographicMetadata(row);

  return {
    archivedAt: parseOptionalTimestamp(row.archived_at),
    bibliographicMetadata,
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
    libraryUpdatedAt: parseTimestamp(row.library_updated_at, row.imported_at),
    mimeType: row.mime_type,
    openCount: row.open_count,
    pdfMetadata: getEffectivePdfMetadata(row),
    readingStatus: normalizeReadingStatus(row.reading_status),
    starredAt: parseOptionalTimestamp(row.starred_at),
    storagePath: row.storage_path,
  };
}

function mergeCloudFields(entry: PdfLibraryEntry, row: UserDocumentRow): PdfLibraryEntry {
  const bibliographicMetadata = mapBibliographicMetadata(row);

  return {
    ...entry,
    archivedAt: parseOptionalTimestamp(row.archived_at),
    bibliographicMetadata,
    cloudDocumentId: row.id,
    contentSha256: row.content_sha256,
    fileName: row.display_file_name || entry.fileName,
    fileSize: row.file_size || entry.fileSize,
    importedAt: Date.parse(row.imported_at),
    lastOpenedAt: Date.parse(row.last_opened_at),
    lastPageIndex: row.last_page_index ?? entry.lastPageIndex,
    lastScrollTop: row.last_scroll_top ?? entry.lastScrollTop,
    lastZoom: row.last_zoom ?? entry.lastZoom,
    libraryUpdatedAt: parseTimestamp(row.library_updated_at, row.imported_at),
    openCount: row.open_count,
    pdfMetadata: getEffectivePdfMetadata(row, entry.pdfMetadata),
    readingStatus: normalizeReadingStatus(row.reading_status),
    starredAt: parseOptionalTimestamp(row.starred_at),
    storagePath: row.storage_path,
  };
}

function rowToFingerprint(row: UserDocumentRow): PdfFingerprint {
  return {
    contentSha256: row.content_sha256,
    fileName: row.display_file_name,
    fileSize: row.file_size,
    pdfMetadata: getEffectivePdfMetadata(row),
    fingerprint: row.pdf_fingerprint,
  };
}

function getUserDocumentColumns() {
  return [
    "abstract",
    "archived_at",
    "arxiv_id",
    "authors",
    "content_sha256",
    "deleted_at",
    "display_file_name",
    "doi",
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
    "publication_venue",
    "publication_year",
    "reading_status",
    "starred_at",
    "storage_path",
    "title",
    "library_updated_at",
    "user_id",
  ].join(",");
}

async function mapLibraryDocumentWithCacheState(
  row: LibraryDocumentSearchRow,
): Promise<LibraryDocument> {
  const localEntry = await getPdfLibraryEntry(row.pdf_fingerprint);

  return mapLibraryDocument(
    row,
    (row.collections ?? []).map(mapLibraryCollection),
    (row.tags ?? []).map(mapLibraryTag),
    Boolean(localEntry?.blob instanceof Blob),
  );
}

function mapLibraryDocument(
  row: UserDocumentRow,
  collections: LibraryCollection[],
  tags: LibraryTag[],
  localCached?: boolean,
): LibraryDocument {
  const entry = mapCloudLibraryEntry(row);

  return {
    ...entry,
    bibliographicMetadata: entry.bibliographicMetadata
      ?? mapBibliographicMetadata(row),
    collections: [...collections].sort(compareLibraryCollections),
    libraryUpdatedAt: entry.libraryUpdatedAt
      ?? parseTimestamp(row.library_updated_at, row.imported_at),
    localCached,
    readingStatus: entry.readingStatus
      ?? normalizeReadingStatus(row.reading_status),
    tags: [...tags].sort(compareLibraryTags),
  };
}

function mapBibliographicMetadata(row: UserDocumentRow): BibliographicMetadata {
  const title = normalizeOptionalText(row.title)
    ?? stripPdfExtension(row.display_file_name);
  const storedAuthors = normalizeAuthors(row.authors ?? []);

  return {
    abstract: normalizeOptionalText(row.abstract) ?? undefined,
    arxivId: normalizeOptionalText(row.arxiv_id) ?? undefined,
    authors: storedAuthors,
    doi: normalizeOptionalText(row.doi) ?? undefined,
    publicationVenue: normalizeOptionalText(row.publication_venue) ?? undefined,
    publicationYear: normalizeYear(row.publication_year) ?? undefined,
    title: title || undefined,
  };
}

function getEffectivePdfMetadata(
  row: UserDocumentRow,
  fallback?: PdfMetadata,
): PdfMetadata | undefined {
  const bibliography = mapBibliographicMetadata(row);
  const title = bibliography.title ?? normalizeOptionalText(fallback?.title);
  const author = bibliography.authors.length > 0
    ? bibliography.authors.join("; ")
    : undefined;

  if (!title && !author) {
    return undefined;
  }

  return {
    ...(fallback ?? {}),
    ...(row.pdf_metadata ?? {}),
    author: author || undefined,
    title: title || undefined,
  };
}

function createDefaultBibliographicMetadata(
  identity: PdfFingerprint,
): BibliographicMetadata {
  const author = normalizeOptionalText(identity.pdfMetadata?.author);

  return {
    authors: author ? [author] : [],
    title: normalizeOptionalText(identity.pdfMetadata?.title)
      ?? stripPdfExtension(identity.fileName)
      ?? undefined,
  };
}

function mapLibraryDocumentPatch(
  patch: LibraryDocumentMetadataPatch,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  if (patch.title !== undefined) {
    values.title = normalizeOptionalText(patch.title);
  }
  if (patch.authors !== undefined) {
    values.authors = normalizeAuthors(patch.authors);
  }
  if (patch.publicationYear !== undefined) {
    values.publication_year = normalizeYear(patch.publicationYear);
  }
  if (patch.publicationVenue !== undefined) {
    values.publication_venue = normalizeOptionalText(patch.publicationVenue);
  }
  if (patch.doi !== undefined) {
    values.doi = normalizeOptionalText(patch.doi);
  }
  if (patch.arxivId !== undefined) {
    values.arxiv_id = normalizeOptionalText(patch.arxivId);
  }
  if (patch.abstract !== undefined) {
    values.abstract = normalizeOptionalText(patch.abstract);
  }
  if (patch.readingStatus !== undefined) {
    values.reading_status = patch.readingStatus;
  }
  if (patch.starred !== undefined) {
    values.starred_at = patch.starred ? new Date().toISOString() : null;
  }
  if (patch.archived !== undefined) {
    values.archived_at = patch.archived ? new Date().toISOString() : null;
  }

  return values;
}

function mapLibraryCollection(row: LibraryCollectionRow): LibraryCollection {
  return {
    color: normalizeOptionalText(row.color) ?? undefined,
    createdAt: parseTimestamp(row.created_at),
    description: normalizeOptionalText(row.description) ?? undefined,
    id: row.id,
    name: row.name,
    parentId: normalizeOptionalText(row.parent_id) ?? undefined,
    sortOrder: normalizeInteger(row.sort_order, 0),
    updatedAt: parseTimestamp(row.updated_at, row.created_at),
  };
}

function mapLibraryTag(row: LibraryTagRow): LibraryTag {
  return {
    color: normalizeOptionalText(row.color) ?? undefined,
    createdAt: parseTimestamp(row.created_at),
    id: row.id,
    name: row.name,
    updatedAt: parseTimestamp(row.updated_at, row.created_at),
  };
}

function compareLibraryCollections(
  left: LibraryCollection,
  right: LibraryCollection,
) {
  return left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function compareLibraryTags(left: LibraryTag, right: LibraryTag) {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

function getLibraryCollectionColumns() {
  return [
    "color",
    "created_at",
    "description",
    "id",
    "name",
    "parent_id",
    "sort_order",
    "updated_at",
    "user_id",
  ].join(",");
}

function getLibraryTagColumns() {
  return [
    "color",
    "created_at",
    "id",
    "name",
    "updated_at",
    "user_id",
  ].join(",");
}

function normalizeReadingStatus(
  value: string | null | undefined,
): LibraryReadingStatus {
  switch (value) {
    case "to-read":
    case "reading":
    case "finished":
      return value;
    default:
      return "inbox";
  }
}

function normalizeReadingStatuses(
  values: LibraryReadingStatus[] | undefined,
): LibraryReadingStatus[] | null {
  if (!values || values.length === 0) {
    return null;
  }

  return Array.from(new Set(values));
}

function normalizeAuthors(values: string[]) {
  const authors: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const author = value.trim();
    const key = author.toLocaleLowerCase();

    if (!author || seen.has(key)) {
      continue;
    }

    seen.add(key);
    authors.push(author);
  }

  return authors;
}

function normalizeIds(values: string[] | undefined): string[] | null {
  if (!values || values.length === 0) {
    return null;
  }

  const ids = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return ids.length > 0 ? ids : null;
}

function requireIds(values: string[], label: string) {
  const ids = normalizeIds(values);

  if (!ids) {
    throw new Error(`${label} must contain at least one id.`);
  }

  return ids;
}

function requireNonEmptyText(value: string, label: string) {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${label} is required.`);
  }

  return normalized;
}

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value.trim() || null;
}

function normalizeYear(value: number | null | undefined): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const year = Math.trunc(value as number);
  return year >= 1 && year <= 3000 ? year : null;
}

function normalizeInteger(value: number | null | undefined, fallback: number) {
  return Number.isFinite(value) ? Math.trunc(value as number) : fallback;
}

function normalizePositiveInteger(
  value: number | null | undefined,
  fallback: number,
) {
  const integer = normalizeInteger(value, fallback);
  return integer > 0 ? integer : fallback;
}

function normalizeNonNegativeInteger(
  value: number | null | undefined,
  fallback: number,
) {
  const integer = normalizeInteger(value, fallback);
  return integer >= 0 ? integer : fallback;
}

function clampInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const integer = normalizeInteger(value, fallback);
  return Math.min(maximum, Math.max(minimum, integer));
}

function parseOptionalTimestamp(value: string | null | undefined) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseTimestamp(
  value: string | null | undefined,
  fallback?: string,
) {
  return parseOptionalTimestamp(value)
    ?? parseOptionalTimestamp(fallback)
    ?? Date.now();
}

function stripPdfExtension(fileName: string) {
  return fileName.replace(/[.]pdf$/i, "").trim() || undefined;
}
