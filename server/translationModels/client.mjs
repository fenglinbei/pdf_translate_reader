import {
  createDeepSeekChatStream,
  DeepSeekClientError,
} from "../deepseek/client.mjs";
import {
  getAvailableModelIds,
  MODEL_DEFAULTS,
  requireModelDefinition,
  resolveTranslationReasoning,
  TRANSLATION_REASONING_EFFORTS as REASONING_EFFORTS,
} from "../../shared/modelRegistry.mjs";
import { getModelProviderConfig } from "../models/providerConfig.mjs";
import { createModelChatBody } from "../models/requestBody.mjs";

const DEFAULT_TRANSLATION_MAX_TOKENS = 16_384;
const MIN_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 65_536;

export const DEFAULT_TRANSLATION_MODEL = MODEL_DEFAULTS.translation;
export const TRANSLATION_MODELS = new Set(getAvailableModelIds("translation"));
export const TRANSLATION_REASONING_EFFORTS = new Set(REASONING_EFFORTS);

export function normalizeTranslationModel(model) {
  return TRANSLATION_MODELS.has(model) ? model : DEFAULT_TRANSLATION_MODEL;
}

export function resolveTranslationReasoningConfig(model, reasoning = {}) {
  return resolveTranslationReasoning(normalizeTranslationModel(model), reasoning);
}

export async function createTranslationChatStream({
  messages,
  model,
  resolvedReasoning,
  signal,
}) {
  if (model !== undefined && !TRANSLATION_MODELS.has(model)) {
    throw new TranslationModelError(400, "unsupported_translation_model", `Unsupported translation model: ${String(model)}`);
  }
  const normalizedModel = normalizeTranslationModel(model);
  const reasoning = resolveTranslationReasoningConfig(normalizedModel, resolvedReasoning);

  if (requireModelDefinition(normalizedModel).provider === "deepseek") {
    try {
      return await createDeepSeekChatStream({
        messages,
        model: normalizedModel,
        resolvedReasoning: reasoning,
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

  if (!providerConfig.apiKeyConfigured) {
    throw new TranslationModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }

  if (!providerConfig.apiBaseUrlConfigured) {
    throw new TranslationModelError(500, `${providerConfig.provider}_api_base_url_missing`, "ALIYUN_API_BASE_URL is not configured for the selected region/workspace.");
  }

  const body = createChatCompletionBody(normalizedModel, messages, reasoning);

  let response;

  try {
    response = await fetch(`${providerConfig.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(body),
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
  return getModelProviderConfig(requireModelDefinition(model).provider);
}

function createChatCompletionBody(model, messages, resolvedReasoning) {
  const definition = requireModelDefinition(model);
  const limitName = definition.provider === "kimi"
    ? "KIMI_TRANSLATION_MAX_COMPLETION_TOKENS"
    : `${definition.provider.toUpperCase()}_TRANSLATION_MAX_TOKENS`;
  return createModelChatBody({
    model,
    messages,
    maxTokens: normalizeOutputTokenLimit(process.env[limitName], DEFAULT_TRANSLATION_MAX_TOKENS),
    deterministic: true,
    temperature: definition.provider === "qwen" ? 0.2 : undefined,
    thinking: {
      enabled: resolvedReasoning.enabled,
      effort: definition.reasoning.translationEffortMap[resolvedReasoning.effort],
    },
  });
}

function normalizeOutputTokenLimit(value, fallback) {
  const parsed = Number(value);

  if (!value?.trim() || !Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Math.round(parsed)));
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
