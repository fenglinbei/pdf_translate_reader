import { getDeepSeekRuntimeConfig } from "../deepseek/config.mjs";
import { getModelMaxTokens } from "../qa/contextBudget.mjs";

const DEFAULT_DEEPSEEK_QA_MODEL = "deepseek-v4-pro";
const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_QA_MODEL = "glm-5.2";

export const QA_CHAT_MODELS = new Set(["deepseek-v4-pro", "glm-5.2"]);

// Both providers expose thinking via { type: "enabled" | "disabled" }.
// Effort enums differ per provider:
//   DeepSeek: "high" | "max"  (low/medium mapped to high)
//   GLM-5.2:  "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none"
const DEEPSEEK_EFFORT_MAP = {
  quick: null,        // thinking disabled
  standard: "high",
  deep: "max",
};
const GLM_EFFORT_MAP = {
  quick: "none",      // thinking enabled but skipped
  standard: "high",
  deep: "max",
};

/**
 * Resolve a frontend reasoningEffort (quick/standard/deep/auto) into a
 * per-provider thinking configuration.
 *
 * `auto` is resolved upstream (agentRunner.inferReasoningEffort) into one of
 * quick/standard/deep before reaching here; if it leaks through we default to
 * "standard".
 *
 * @returns {{ enabled: boolean, effort?: string }}
 */
export function resolveThinkingConfig(model, reasoningEffort) {
  const normalizedModel = normalizeQaChatModel(model);
  const effortKey = reasoningEffort === "auto" ? "standard" : (reasoningEffort ?? "standard");
  const provider = normalizedModel === "glm-5.2" ? "glm" : "deepseek";
  const effortMap = provider === "glm" ? GLM_EFFORT_MAP : DEEPSEEK_EFFORT_MAP;
  // null is a valid map value (DeepSeek quick = thinking disabled); only fall
  // back when the key itself is missing (undefined).
  const effort = effortMap[effortKey] === undefined ? effortMap.standard : effortMap[effortKey];

  if (effort === null) {
    return { enabled: false };
  }

  return { enabled: true, effort };
}

export function normalizeQaChatModel(model) {
  if (QA_CHAT_MODELS.has(model)) {
    return model;
  }

  const configuredDefault = process.env.QA_DEFAULT_CHAT_MODEL;

  return QA_CHAT_MODELS.has(configuredDefault)
    ? configuredDefault
    : DEFAULT_DEEPSEEK_QA_MODEL;
}

export async function streamQaChatCompletion({
  messages,
  model,
  reasoningEffort,
  onDelta,
  onFinish,
  onUsage,
  onThinking,
  signal,
}) {
  const normalizedModel = normalizeQaChatModel(model);
  const providerConfig = getProviderConfig(normalizedModel);

  if (!providerConfig.apiKey) {
    throw new QaChatModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }

  const thinkingConfig = resolveThinkingConfig(normalizedModel, reasoningEffort);
  let response;

  try {
    response = await fetch(`${providerConfig.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(createChatCompletionBody({
        messages,
        model: normalizedModel,
        provider: providerConfig.provider,
        providerModel: providerConfig.providerModel,
        thinkingConfig,
      })),
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

    throw new QaChatModelError(
      502,
      `${providerConfig.provider}_network_error`,
      `Network connection to ${providerConfig.displayName} failed.`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new QaChatModelError(
      response.status,
      getProviderErrorCode(providerConfig.provider, response.status),
      parseProviderErrorMessage(body) ??
        `${providerConfig.displayName} API returned ${response.status}.`,
    );
  }

  if (!response.body) {
    throw new QaChatModelError(
      502,
      `${providerConfig.provider}_stream_missing`,
      `${providerConfig.displayName} response stream is missing.`,
    );
  }

  await readOpenAiCompatibleStream(response.body, {
    onDelta,
    onFinish,
    onUsage,
    onThinking,
  });
}

export async function createQaChatCompletion({
  messages,
  model,
  signal,
  temperature = 0.1,
}) {
  const normalizedModel = normalizeQaChatModel(model);
  const providerConfig = getProviderConfig(normalizedModel);

  if (!providerConfig.apiKey) {
    throw new QaChatModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }

  let response;

  try {
    response = await fetch(`${providerConfig.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(createChatCompletionBody({
        messages,
        model: normalizedModel,
        provider: providerConfig.provider,
        providerModel: providerConfig.providerModel,
        stream: false,
        temperature,
        thinkingConfig: { enabled: false },
      })),
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

    throw new QaChatModelError(
      502,
      `${providerConfig.provider}_network_error`,
      `Network connection to ${providerConfig.displayName} failed.`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");

    throw new QaChatModelError(
      response.status,
      getProviderErrorCode(providerConfig.provider, response.status),
      parseProviderErrorMessage(body) ??
        `${providerConfig.displayName} API returned ${response.status}.`,
    );
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;

  return {
    content: typeof content === "string" ? content : "",
    finishReason: payload?.choices?.[0]?.finish_reason,
    usage: normalizeUsage(payload?.usage),
  };
}

export class QaChatModelError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "QaChatModelError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getProviderConfig(model) {
  if (model === "glm-5.2") {
    return {
      apiBaseUrl: process.env.GLM_API_BASE_URL ?? DEFAULT_GLM_API_BASE_URL,
      apiKey: process.env.GLM_API_KEY,
      apiKeyName: "GLM_API_KEY",
      displayName: "GLM",
      provider: "glm",
      providerModel: process.env.GLM_QA_MODEL || DEFAULT_GLM_QA_MODEL,
    };
  }

  const deepSeekConfig = getDeepSeekRuntimeConfig();

  return {
    apiBaseUrl: deepSeekConfig.apiBaseUrl,
    apiKey: deepSeekConfig.apiKey,
    apiKeyName: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    provider: "deepseek",
    providerModel: process.env.DEEPSEEK_QA_MODEL || DEFAULT_DEEPSEEK_QA_MODEL,
  };
}

function createChatCompletionBody({
  messages,
  model,
  provider,
  providerModel,
  stream = true,
  temperature = 0.2,
  thinkingConfig,
}) {
  const body = {
    messages,
    model: providerModel,
    stream,
  };

  // Both providers ignore temperature in thinking mode, but we still pass it
  // for the non-thinking path (controller/router non-stream calls).
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  if (stream) {
    body.stream_options = {
      include_usage: true,
    };
  }

  // Thinking configuration. Both providers accept { type: "enabled" | "disabled" }.
  // GLM-5.2 additionally supports reasoning_effort across the full enum;
  // DeepSeek only honors "high" | "max".
  if (thinkingConfig && thinkingConfig.enabled) {
    body.thinking = { type: "enabled" };
    if (thinkingConfig.effort) {
      body.reasoning_effort = thinkingConfig.effort;
    }
  } else {
    body.thinking = { type: "disabled" };
  }

  // Bound generated output so a runaway answer cannot exhaust the window.
  body.max_tokens = getModelMaxTokens(model);

  return body;
}

async function readOpenAiCompatibleStream(stream, handlers) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      processOpenAiCompatibleSseLine(line, handlers);
    }
  }

  if (buffer.trim()) {
    processOpenAiCompatibleSseLine(buffer, handlers);
  }
}

function processOpenAiCompatibleSseLine(line, handlers) {
  if (!line.startsWith("data:")) {
    return;
  }

  const data = line.slice("data:".length).trim();

  if (!data || data === "[DONE]") {
    return;
  }

  let chunk;

  try {
    chunk = JSON.parse(data);
  } catch {
    // Ignore malformed keep-alive / partial chunks.
    return;
  }

  const delta = chunk.choices?.[0]?.delta;
  const reasoningContent = delta?.reasoning_content;
  const content = delta?.content;
  const finishReason = chunk.choices?.[0]?.finish_reason;

  // In thinking mode the model emits reasoning_content first, then content.
  // They are mutually exclusive within a single delta.
  if (typeof reasoningContent === "string" && reasoningContent.length > 0) {
    handlers.onThinking?.(reasoningContent);
  }

  if (typeof content === "string" && content.length > 0) {
    handlers.onDelta?.(content);
  }

  if (chunk.usage) {
    handlers.onUsage?.(normalizeUsage(chunk.usage));
  }

  if (finishReason) {
    handlers.onFinish?.(finishReason);
  }
}

function normalizeUsage(usage) {
  return {
    completionTokens: normalizeNumber(usage.completion_tokens ?? usage.completionTokens),
    promptCacheHitTokens: normalizeNumber(
      usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens,
    ),
    promptCacheMissTokens: normalizeNumber(
      usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens,
    ),
    promptTokens: normalizeNumber(usage.prompt_tokens ?? usage.promptTokens),
    reasoningTokens: normalizeNumber(
      usage.completion_tokens_details?.reasoning_tokens
        ?? usage.completionTokensDetails?.reasoningTokens,
    ),
    totalTokens: normalizeNumber(usage.total_tokens ?? usage.totalTokens),
  };
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
