import { getSupabaseAccessToken, requireSupabaseClient } from "../auth/supabaseClient";
import type { LibraryDocument, LibraryMetadataField } from "../types/domain";

export async function queueMetadataRecognition(documentIds: string[]) {
  const token = await getSupabaseAccessToken();
  if (!token) throw new Error("Sign in before recognizing metadata.");
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? "/api"}/library/metadata`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ documentIds }), signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || "Could not start metadata recognition.");
  return payload as { queued: number; requested: number };
}

export async function applyMetadataSuggestions(document: LibraryDocument, fields: LibraryMetadataField[]) {
  const { error } = await requireSupabaseClient().rpc("apply_user_document_metadata", {
    p_document_id: document.cloudDocumentId, p_job_id: document.metadataState?.jobId,
    p_revision: document.metadataRevision ?? 0, p_fields: fields,
  });
  if (error) throw error;
}
