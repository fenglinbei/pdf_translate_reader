import { getDeepSeekRuntimeConfig } from "../deepseek/config.mjs";
import { writeJson } from "../http/json.mjs";

export function handleHealth(response) {
  const deepseek = getDeepSeekRuntimeConfig();

  writeJson(response, 200, {
    status: "ok",
    service: "pdf-translate-reader-api",
    deepseek: {
      apiKeyConfigured: deepseek.apiKeyConfigured,
    },
  });
}
