import { requireSupabaseClient } from "../auth/supabaseClient";

type QaThreadIdRow = {
  id: string;
};

export async function deleteCloudQaStateByDocument(cloudDocumentId: string | undefined) {
  if (!cloudDocumentId) {
    return;
  }

  const now = new Date().toISOString();
  const threadIds = await listQaThreadIdsForDocument(cloudDocumentId);

  await Promise.all([
    softDeleteTableRows("user_paper_chunks", cloudDocumentId, now, true),
    softDeleteTableRows("user_paper_references", cloudDocumentId, now, true),
    softDeleteTableRows("user_qa_citations", cloudDocumentId, now, false),
    softDeleteTableRows("user_qa_index_jobs", cloudDocumentId, now, true),
    softDeleteTableRows("user_qa_api_logs", cloudDocumentId, now, false),
    softDeleteQaThreads(threadIds, now),
    softDeleteQaMessages(threadIds, now),
  ]);
}

async function listQaThreadIdsForDocument(cloudDocumentId: string) {
  const [activeResult, referenceResult] = await Promise.all([
    requireSupabaseClient()
      .from("user_qa_threads")
      .select("id")
      .eq("active_user_document_id", cloudDocumentId)
      .is("deleted_at", null),
    requireSupabaseClient()
      .from("user_qa_threads")
      .select("id")
      .contains("reference_document_ids", [cloudDocumentId])
      .is("deleted_at", null),
  ]);

  if (activeResult.error) {
    throw activeResult.error;
  }

  if (referenceResult.error) {
    throw referenceResult.error;
  }

  return Array.from(new Set([
    ...((activeResult.data ?? []) as unknown as QaThreadIdRow[]).map((row) => row.id),
    ...((referenceResult.data ?? []) as unknown as QaThreadIdRow[]).map((row) => row.id),
  ]));
}

async function softDeleteTableRows(
  tableName: string,
  cloudDocumentId: string,
  deletedAt: string,
  hasUpdatedAt: boolean,
) {
  const patch = hasUpdatedAt
    ? { deleted_at: deletedAt, updated_at: deletedAt }
    : { deleted_at: deletedAt };
  const { error } = await requireSupabaseClient()
    .from(tableName)
    .update(patch)
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

async function softDeleteQaThreads(threadIds: string[], deletedAt: string) {
  if (threadIds.length === 0) {
    return;
  }

  const { error } = await requireSupabaseClient()
    .from("user_qa_threads")
    .update({
      deleted_at: deletedAt,
      updated_at: deletedAt,
    })
    .in("id", threadIds)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

async function softDeleteQaMessages(threadIds: string[], deletedAt: string) {
  if (threadIds.length === 0) {
    return;
  }

  const { error } = await requireSupabaseClient()
    .from("user_qa_messages")
    .update({
      deleted_at: deletedAt,
      updated_at: deletedAt,
    })
    .in("thread_id", threadIds)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

