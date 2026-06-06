import { getDeepSeekRuntimeConfig } from "../deepseek/config.mjs";
import { writeJson } from "../http/json.mjs";
import { getSupabaseRuntimeConfig } from "../supabase/config.mjs";

export function handleHealth(response) {
  const deepseek = getDeepSeekRuntimeConfig();
  const supabase = getSupabaseRuntimeConfig();

  writeJson(response, 200, {
    status: "ok",
    service: "pdf-translate-reader-api",
    deepseek: {
      apiKeyConfigured: deepseek.apiKeyConfigured,
    },
    supabase: {
      configured: supabase.configured,
      serviceRoleConfigured: supabase.serviceRoleConfigured,
    },
  });
}
