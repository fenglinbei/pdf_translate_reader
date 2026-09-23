import { requireSupabaseServiceClient } from "../supabase/service.mjs";
import { createQaChatCompletion } from "../chatModels/client.mjs";
import { loadDocumentHeader } from "./pdfHeader.mjs";
import { lookupDoi, lookupArxiv } from "./providers.mjs";
import { recognizeMetadata, mergeMetadata } from "./metadata.mjs";

export async function runMetadataJob(document, {
  client = requireSupabaseServiceClient(), extractHeader = loadDocumentHeader,
  doiLookup = lookupDoi, arxivLookup = lookupArxiv, complete = createQaChatCompletion,
} = {}) {
  const signal = AbortSignal.timeout(150000);
  let result;
  let settingsUnavailable = false;
  try {
    const header = await extractHeader(document, client, signal);
    const model = process.env.LIBRARY_METADATA_MODEL || "deepseek-flash";
    result = await recognizeMetadata({
      document, header,
      lookupDoi: id => doiLookup(id, signal), lookupArxiv: id => arxivLookup(id, signal),
      aiAllowed: async () => {
        // Re-read immediately before inference so disabling AI also affects queued work.
        const { data, error } = await client.from("user_settings").select("library_metadata_ai_enabled")
          .eq("user_id", document.user_id).maybeSingle();
        if (error) { settingsUnavailable = true; return false; }
        return data?.library_metadata_ai_enabled !== false;
      },
      ai: async messages => ({ ...await complete({ messages, model, maxTokens: 2200,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]), reasoningEffort: "quick" }), model }),
    });
    if (settingsUnavailable) result.warnings.push("settings_unavailable");
  } catch (error) {
    result = { candidates: {}, error: signal.aborted ? "timeout" : error?.message === "file_too_large" ? "file_too_large" : "read_failed" };
  }
  // A person can edit while inference is running. Re-merge fresh values and
  // retry the atomic revision check without making any extra model requests.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: fresh, error } = await client.from("user_documents").select("*")
      .eq("id", document.id).eq("user_id", document.user_id).is("deleted_at", null).maybeSingle();
    if (error) throw error;
    if (!fresh || fresh.metadata_state?.jobId !== document.metadata_state.jobId || fresh.metadata_state?.status !== "running") return;
    const merged = mergeMetadata(fresh, result);
    const { data: saved, error: saveError } = await client.rpc("finish_document_metadata_job", {
      p_user_id: fresh.user_id, p_document_id: fresh.id, p_job_id: fresh.metadata_state.jobId,
      p_revision: fresh.metadata_revision, p_patch: merged.patch, p_sources: merged.sources, p_state: merged.state,
    });
    if (saveError) throw saveError;
    if (saved) return;
  }
  // The lease makes this recoverable if a user keeps editing or the DB is unavailable.
}

export function startMetadataWorker() {
  let stopped = false; let timer; let lastWarning = 0;
  const tick = async () => {
    try {
      const client = requireSupabaseServiceClient();
      const { data, error } = await client.rpc("claim_document_metadata_job");
      if (error) throw error;
      if (data) await runMetadataJob(data, { client });
    } catch {
      if (Date.now() - lastWarning > 60000) {
        console.warn("Metadata worker unavailable; check the library metadata migration and service configuration.");
        lastWarning = Date.now();
      }
    } finally {
      if (!stopped) { timer = setTimeout(tick, 2500); timer.unref?.(); }
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
