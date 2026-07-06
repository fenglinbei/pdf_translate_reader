import { requireSupabaseClient } from "../auth/supabaseClient";
import type { QaApiLog } from "../types/domain";

type QaApiLogRow = {
  error_message: string | null;
  id: string;
  message_id: string | null;
  model: string | null;
  payload: unknown;
  pdf_fingerprint: string | null;
  prompt_version: string | null;
  request_finished_at: string | null;
  request_kind: QaApiLog["requestKind"];
  request_started_at: string;
  retriever_version: string | null;
  status: QaApiLog["status"];
  thread_id: string | null;
  usage: QaApiLog["usage"] | null;
  user_document_id: string | null;
};

export async function listCloudQaApiLogs(cloudDocumentId?: string) {
  let query = requireSupabaseClient()
    .from("user_qa_api_logs")
    .select([
      "error_message",
      "id",
      "message_id",
      "model",
      "payload",
      "pdf_fingerprint",
      "prompt_version",
      "request_finished_at",
      "request_kind",
      "request_started_at",
      "retriever_version",
      "status",
      "thread_id",
      "usage",
      "user_document_id",
    ].join(","))
    .order("request_started_at", { ascending: false });

  if (cloudDocumentId) {
    query = query.eq("user_document_id", cloudDocumentId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as QaApiLogRow[]).map(rowToQaApiLog);
}

function rowToQaApiLog(row: QaApiLogRow): QaApiLog {
  return {
    cloudDocumentId: row.user_document_id ?? undefined,
    errorMessage: row.error_message ?? undefined,
    id: row.id,
    messageId: row.message_id ?? undefined,
    model: isQaModel(row.model) ? row.model : undefined,
    payload: row.payload ?? undefined,
    pdfFingerprint: row.pdf_fingerprint ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    requestFinishedAt: parseIsoTime(row.request_finished_at),
    requestKind: row.request_kind,
    requestStartedAt: parseIsoTime(row.request_started_at) ?? Date.now(),
    retrieverVersion: row.retriever_version ?? undefined,
    status: row.status,
    threadId: row.thread_id ?? undefined,
    usage: row.usage ?? undefined,
  };
}

function isQaModel(value: unknown): value is QaApiLog["model"] {
  return value === "deepseek-v4-pro" || value === "glm-5.2";
}

function parseIsoTime(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}
