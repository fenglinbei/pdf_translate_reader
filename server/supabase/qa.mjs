import {
  QA_CHUNKER_VERSION,
  QA_REFERENCE_MATCHER_VERSION,
  QA_RETRIEVER_VERSION,
} from "../qa/config.mjs";
import { getEmbeddingRuntimeConfig } from "../embedding/config.mjs";
import {
  QA_INDEX_ACTIVE_STATUSES,
  enqueueQaIndexJob,
} from "../qa/indexJobRunner.mjs";
import {
  requireSupabaseServiceClient,
  SupabaseServiceError,
} from "./service.mjs";

const DUPLICATE_KEY_ERROR_CODE = "23505";

const USER_DOCUMENT_COLUMNS = [
  "content_sha256",
  "display_file_name",
  "id",
  "pdf_fingerprint",
  "user_id",
].join(",");

const QA_INDEX_JOB_COLUMNS = [
  "chunker_version",
  "content_sha256",
  "created_at",
  "deleted_at",
  "embedding_dimensions",
  "embedding_model",
  "error_message",
  "finished_at",
  "id",
  "payload",
  "pdf_fingerprint",
  "progress_percent",
  "reference_matcher_version",
  "retriever_version",
  "source",
  "started_at",
  "status",
  "updated_at",
  "user_document_id",
  "user_id",
].join(",");

export async function getLatestQaIndexJob({ userDocumentId, userId }) {
  await requireUserDocument({ userDocumentId, userId });

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select(QA_INDEX_JOB_COLUMNS)
    .eq("user_id", userId)
    .eq("user_document_id", userDocumentId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_index_job_query_failed", "Could not read QA index job.");
  }

  return data ? rowToQaIndexJob(data) : undefined;
}

export async function createOrUpdateIndexJob({ source, userDocumentId, userId }) {
  const document = await requireUserDocument({ userDocumentId, userId });
  const existingJob = await getActiveQaIndexJob({ userDocumentId, userId });

  if (existingJob) {
    return {
      job: existingJob,
      reused: true,
    };
  }

  const now = new Date().toISOString();
  const embedding = getEmbeddingRuntimeConfig();
  const jobInsert = {
    chunker_version: QA_CHUNKER_VERSION,
    content_sha256: document.content_sha256,
    embedding_dimensions: embedding.configured ? embedding.dimensions : null,
    embedding_model: embedding.configured ? embedding.model : "none",
    pdf_fingerprint: document.pdf_fingerprint,
    progress_percent: 0,
    reference_matcher_version: QA_REFERENCE_MATCHER_VERSION,
    retriever_version: QA_RETRIEVER_VERSION,
    source,
    status: "pending",
    updated_at: now,
    user_document_id: document.id,
    user_id: userId,
    payload: {
      displayFileName: document.display_file_name,
      embeddingProvider: embedding.provider,
      source,
    },
  };

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .insert(jobInsert)
    .select(QA_INDEX_JOB_COLUMNS)
    .single();

  if (error) {
    if (getSupabaseErrorCode(error) === DUPLICATE_KEY_ERROR_CODE) {
      const duplicateJob = await getActiveQaIndexJob({ userDocumentId, userId });

      if (duplicateJob) {
        return {
          job: duplicateJob,
          reused: true,
        };
      }
    }

    throw toSupabaseServiceError(error, "qa_index_job_create_failed", "Could not create QA index job.");
  }

  const job = rowToQaIndexJob(data);

  enqueueQaIndexJob(job);

  return {
    job,
    reused: false,
  };
}

async function getActiveQaIndexJob({ userDocumentId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select(QA_INDEX_JOB_COLUMNS)
    .eq("user_id", userId)
    .eq("user_document_id", userDocumentId)
    .in("status", QA_INDEX_ACTIVE_STATUSES)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_index_job_query_failed", "Could not read QA index job.");
  }

  return data ? rowToQaIndexJob(data) : undefined;
}

async function requireUserDocument({ userDocumentId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_documents")
    .select(USER_DOCUMENT_COLUMNS)
    .eq("id", userDocumentId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_document_query_failed", "Could not read document.");
  }

  if (!data) {
    throw new SupabaseServiceError(
      404,
      "qa_document_not_found",
      "Document was not found for this user.",
    );
  }

  return data;
}

function rowToQaIndexJob(row) {
  return {
    chunkerVersion: row.chunker_version,
    cloudDocumentId: row.user_document_id,
    contentSha256: row.content_sha256,
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    embeddingDimensions: typeof row.embedding_dimensions === "number"
      ? row.embedding_dimensions
      : undefined,
    embeddingModel: row.embedding_model ?? "none",
    errorMessage: row.error_message ?? undefined,
    finishedAt: parseIsoTime(row.finished_at),
    id: row.id,
    payload: row.payload ?? undefined,
    pdfFingerprint: row.pdf_fingerprint,
    progressPercent: typeof row.progress_percent === "number" ? row.progress_percent : undefined,
    referenceMatcherVersion: row.reference_matcher_version,
    retrieverVersion: row.retriever_version,
    source: row.source,
    startedAt: parseIsoTime(row.started_at),
    status: row.status,
    updatedAt: parseIsoTime(row.updated_at) ?? Date.now(),
  };
}

function toSupabaseServiceError(error, code, fallbackMessage) {
  return new SupabaseServiceError(
    500,
    code,
    error?.message || fallbackMessage,
  );
}

function getSupabaseErrorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

function parseIsoTime(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}
