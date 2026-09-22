// Server-only configuration. API key values must never enter the shared
// catalog, frontend bundles, or health responses.
const PROVIDERS = {
  deepseek: {
    displayName: "DeepSeek",
    apiKeyNames: ["DEEPSEEK_API_KEY"],
    apiBaseUrlNames: ["DEEPSEEK_API_BASE_URL"],
    defaultApiBaseUrl: "https://api.deepseek.com",
  },
  glm: {
    displayName: "GLM",
    apiKeyNames: ["GLM_API_KEY"],
    apiBaseUrlNames: ["GLM_API_BASE_URL"],
    defaultApiBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  kimi: {
    displayName: "Kimi",
    apiKeyNames: ["KIMI_API_KEY"],
    apiBaseUrlNames: ["KIMI_API_BASE_URL", "KIMI_BASE_URL"],
    defaultApiBaseUrl: "https://api.moonshot.cn/v1",
  },
  qwen: {
    displayName: "Qwen",
    apiKeyNames: ["ALIYUN_API_KEY", "DASHSCOPE_API_KEY"],
    apiBaseUrlNames: ["ALIYUN_API_BASE_URL", "QWEN_API_BASE_URL"],
    // Region/workspace must match the key. Do not guess a deployment region.
    defaultApiBaseUrl: undefined,
  },
};

export const TRANSLATION_PROVIDER_KEY_NAMES = Object.freeze(
  Object.values(PROVIDERS).flatMap((provider) => provider.apiKeyNames),
);

export function getModelProviderConfig(provider, env = process.env) {
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new Error(`Unknown model provider: ${String(provider)}`);
  }
  const definition = PROVIDERS[provider];
  const apiKeyName = definition.apiKeyNames.find((name) => env[name]?.trim())
    ?? definition.apiKeyNames[0];
  const baseUrlName = definition.apiBaseUrlNames.find((name) => env[name]?.trim());
  const apiBaseUrl = (baseUrlName ? env[baseUrlName].trim() : definition.defaultApiBaseUrl)
    ?.replace(/\/+$/, "");
  return {
    provider,
    displayName: definition.displayName,
    apiKeyName,
    apiKey: env[apiKeyName],
    apiKeyConfigured: Boolean(env[apiKeyName]?.trim()),
    apiBaseUrl,
    apiBaseUrlConfigured: Boolean(apiBaseUrl),
  };
}
