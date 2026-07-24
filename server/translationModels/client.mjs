import {
  createDeepSeekChatStream,
  DeepSeekClientError,
} from "../deepseek/client.mjs";

const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_KIMI_API_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_GLM_MAX_TOKENS = 16_384;
const DEFAULT_KIMI_MAX_COMPLETION_TOKENS = 16_384;
const MIN_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 65_536;

export const DEFAULT_TRANSLATION_MODEL = "deepseek-v4-flash";
export const TRANSLATION_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.2",
  "kimi-k3",
]);
export const TRANSLATION_REASONING_EFFORTS = new Set(["low", "high", "max"]);

export function normalizeTranslationModel(model) {
  return TRANSLATION_MODELS.has(model) ? model : DEFAULT_TRANSLATION_MODEL;
}

export function resolveTranslationReasoningConfig(model, reasoning = {}) {
  const normalizedModel = normalizeTranslationModel(model);
  const defaultEnabled = normalizedModel === "kimi-k3";
  const defaultEffort = normalizedModel === "kimi-k3" ? "max" : "high";
  const requestedEnabled = typeof reasoning.enabled === "boolean"
    ? reasoning.enabled
    : defaultEnabled;
  const requestedEffort = TRANSLATION_REASONING_EFFORTS.has(reasoning.effort)
    ? reasoning.effort
    : defaultEffort;
  const enabled = normalizedModel === "kimi-k3" ? true : requestedEnabled;
  const effort = normalizedModel !== "kimi-k3" && requestedEffort === "low"
    ? "high"
    : requestedEffort;

  return {
    effort,
    enabled,
    forced: enabled !== requestedEnabled,
    requestedEnabled,
  };
}

export async function createTranslationChatStream({
  messages,
  model,
  resolvedReasoning,
  signal,
}) {
  const normalizedModel = normalizeTranslationModel(model);

  if (normalizedModel === "deepseek-v4-flash" || normalizedModel === "deepseek-v4-pro") {
    try {
      return await createDeepSeekChatStream({
        messages,
        model: normalizedModel,
        resolvedReasoning,
        signal,
      });
    } catch (error) {
      if (error instanceof DeepSeekClientError) {
        throw new TranslationModelError(error.statusCode, error.code, error.message);
      }

      throw error;
    }
  }

  const providerConfig = getProviderConfig(normalizedModel);

  if (!providerConfig.apiKey) {
    throw new TranslationModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }

  let response;

  try {
    response = await fetch(`${providerConfig.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(createChatCompletionBody(
        normalizedModel,
        messages,
        resolvedReasoning,
      )),
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    throw new TranslationModelError(
      502,
      `${providerConfig.provider}_network_error`,
      `Network connection to ${providerConfig.displayName} failed.`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new TranslationModelError(
      response.status,
      getProviderErrorCode(providerConfig.provider, response.status),
      parseProviderErrorMessage(body) ??
        `${providerConfig.displayName} API returned ${response.status}.`,
    );
  }

  if (!response.body) {
    throw new TranslationModelError(
      502,
      `${providerConfig.provider}_stream_missing`,
      `${providerConfig.displayName} response stream is missing.`,
    );
  }

  return response.body;
}

export class TranslationModelError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "TranslationModelError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getProviderConfig(model) {
  if (model === "glm-5.2") {
    return {
      apiBaseUrl: normalizeBaseUrl(
        process.env.GLM_API_BASE_URL ?? DEFAULT_GLM_API_BASE_URL,
      ),
      apiKey: process.env.GLM_API_KEY,
      apiKeyName: "GLM_API_KEY",
      displayName: "GLM",
      provider: "glm",
    };
  }

  return {
    apiBaseUrl: normalizeBaseUrl(
      process.env.KIMI_API_BASE_URL ??
        process.env.KIMI_BASE_URL ??
        DEFAULT_KIMI_API_BASE_URL,
    ),
    apiKey: process.env.KIMI_API_KEY,
    apiKeyName: "KIMI_API_KEY",
    displayName: "Kimi",
    provider: "kimi",
  };
}

function createChatCompletionBody(model, messages, resolvedReasoning) {
  if (model === "glm-5.2") {
    const body = {
      do_sample: false,
      max_tokens: normalizeOutputTokenLimit(
        process.env.GLM_TRANSLATION_MAX_TOKENS,
        DEFAULT_GLM_MAX_TOKENS,
      ),
      messages,
      model,
      stream: true,
    };

    if (resolvedReasoning?.enabled) {
      body.reasoning_effort = resolvedReasoning.effort === "low"
        ? "high"
        : resolvedReasoning.effort;
      body.thinking = {
        type: "enabled",
      };
    } else {
      body.thinking = {
        type: "disabled",
      };
    }

    return body;
  }

  const body = {
    max_completion_tokens: normalizeOutputTokenLimit(
      process.env.KIMI_TRANSLATION_MAX_COMPLETION_TOKENS,
      DEFAULT_KIMI_MAX_COMPLETION_TOKENS,
    ),
    messages,
    model,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  if (resolvedReasoning) {
    body.reasoning_effort = resolvedReasoning.effort;
  }

  return body;
}

function normalizeOutputTokenLimit(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(parsed)));
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function getProviderErrorCode(provider, statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return `${provider}_auth_error`;
  }

  if (statusCode === 408 || statusCode === 504) {
    return `${provider}_timeout`;
  }

  if (statusCode === 429) {
    return `${provider}_rate_limited`;
  }

  if (statusCode >= 500) {
    return `${provider}_server_error`;
  }

  return `${provider}_api_error`;
}

function parseProviderErrorMessage(body) {
  if (!body) {
    return undefined;
  }

  try {
    const payload = JSON.parse(body);

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }

    if (typeof payload?.message === "string") {
      return payload.message;
    }
  } catch {
    return body.slice(0, 500);
  }

  return undefined;
}
