import { getDeepSeekRuntimeConfig } from "../deepseek/config.mjs";
import { getEmbeddingRuntimeConfig } from "../embedding/config.mjs";
import { writeJson } from "../http/json.mjs";
import { getSupabaseRuntimeConfig } from "../supabase/config.mjs";

export function handleHealth(response) {
  const deepseek = getDeepSeekRuntimeConfig();
  const embedding = getEmbeddingRuntimeConfig();
  const supabase = getSupabaseRuntimeConfig();

  writeJson(response, 200, {
    status: "ok",
    service: "pdf-translate-reader-api",
    deepseek: {
      apiKeyConfigured: deepseek.apiKeyConfigured,
    },
    translation: {
      deepseek: {
        apiKeyConfigured: deepseek.apiKeyConfigured,
      },
      glm: {
        apiKeyConfigured: Boolean(process.env.GLM_API_KEY),
      },
      kimi: {
        apiKeyConfigured: Boolean(process.env.KIMI_API_KEY),
      },
    },
    embedding: {
      configured: embedding.configured,
      dimensions: embedding.dimensions,
      model: embedding.model,
      provider: embedding.provider,
    },
    supabase: {
      configured: supabase.configured,
      serviceRoleConfigured: supabase.serviceRoleConfigured,
    },
  });
}
