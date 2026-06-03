import { requireSupabaseClient } from "../auth/supabaseClient";
import type { ApiCallLog } from "../types/domain";
import { requireCurrentUserId } from "./currentUser";

type ApiLogRow = {
  payload: ApiCallLog;
};

export async function putCloudApiCallLog(log: ApiCallLog) {
  const userId = await requireCurrentUserId();
  const { error } = await requireSupabaseClient()
    .from("api_call_logs")
    .insert({
      id: log.id,
      payload: log,
      pdf_fingerprint: log.pdfFingerprint,
      request_started_at: new Date(log.requestStartedAt).toISOString(),
      user_document_id: log.cloudDocumentId ?? null,
      user_id: userId,
    });

  if (error) {
    throw error;
  }
}

export async function listCloudApiCallLogs(cloudDocumentId?: string) {
  let query = requireSupabaseClient()
    .from("api_call_logs")
    .select("payload")
    .order("request_started_at", { ascending: false });

  if (cloudDocumentId) {
    query = query.eq("user_document_id", cloudDocumentId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as ApiLogRow[]).map((row) => row.payload);
}
