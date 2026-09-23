import { writeJson } from "../http/json.mjs";
import { requireSupabaseServiceClient } from "../supabase/service.mjs";

export function normalizeMetadataRequest(body) {
  const ids = body?.documentIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
    ids.some(id => typeof id !== "string" || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id))) {
    throw new Error("Select between 1 and 100 documents.");
  }
  return [...new Set(ids)];
}

export async function handleLibraryRoute(request, response, url, user, client = requireSupabaseServiceClient()) {
  if (request.method !== "POST" || url.pathname !== "/api/library/metadata") {
    writeJson(response, 404, { error: { code: "not_found", message: "Route not found" } }); return;
  }
  let ids;
  try {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8192) throw new Error("Request too large.");
      chunks.push(chunk);
    }
    ids = normalizeMetadataRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    writeJson(response, 400, { error: { code: "invalid_metadata_request", message: "Select between 1 and 100 documents." } }); return;
  }
  const { data, error } = await client.rpc("queue_document_metadata", { p_user_id: user.id, p_document_ids: ids });
  if (error) {
    writeJson(response, error.code === "P0002" ? 404 : 503, {
      error: { code: "metadata_unavailable", message: error.code === "P0002" ? "Document not found." : "Metadata recognition is unavailable. Check the database migration and retry." },
    }); return;
  }
  writeJson(response, 202, { queued: data, requested: ids.length });
}
