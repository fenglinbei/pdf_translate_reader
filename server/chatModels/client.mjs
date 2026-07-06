import { getDeepSeekRuntimeConfig } from "../deepseek/config.mjs";

const DEFAULT_DEEPSEEK_QA_MODEL = "deepseek-v4-pro";
const DEFAULT_GLM_API_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_GLM_QA_MODEL = "glm-5.2";

export const QA_CHAT_MODELS = new Set(["deepseek-v4-pro", "glm-5.2"]);

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
  onDelta,
  onFinish,
  onUsage,
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

  let response;

  try {
    response = await fetch(`${providerConfig.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(createChatCompletionBody({
        messages,
        provider: providerConfig.provider,
        providerModel: providerConfig.providerModel,
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
  });
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

function createChatCompletionBody({ messages, provider, providerModel }) {
  const body = {
    messages,
    model: providerModel,
    stream: true,
    stream_options: {
      include_usage: true,
    },
    temperature: 0.2,
  };

  if (provider === "deepseek") {
    body.thinking = {
      type: "disabled",
    };
  }

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

  const chunk = JSON.parse(data);
  const content = chunk.choices?.[0]?.delta?.content;
  const finishReason = chunk.choices?.[0]?.finish_reason;

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
