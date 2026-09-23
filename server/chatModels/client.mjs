import { getModelProviderConfig } from "../models/providerConfig.mjs";
import { createModelChatBody, normalizeModelUsage } from "../models/requestBody.mjs";
import { getModelMaxTokens } from "../qa/contextBudget.mjs";
import {
  getAvailableModelIds,
  MODEL_DEFAULTS,
  requireModelDefinition,
  resolveQaThinking,
} from "../../shared/modelRegistry.mjs";

export const QA_CHAT_MODELS = new Set(getAvailableModelIds("qa"));

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
  return resolveQaThinking(normalizeQaChatModel(model), reasoningEffort);
}

export function normalizeQaChatModel(model) {
  if (QA_CHAT_MODELS.has(model)) {
    return model;
  }

  if (model !== undefined && model !== null && model !== "") {
    throw new QaChatModelError(400, "unsupported_qa_model", `Unsupported QA model: ${String(model)}`);
  }

  const configuredDefault = process.env.QA_DEFAULT_CHAT_MODEL;

  return QA_CHAT_MODELS.has(configuredDefault)
    ? configuredDefault
    : MODEL_DEFAULTS.qa;
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

  if (!providerConfig.apiKeyConfigured) {
    throw new QaChatModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }
  assertProviderBaseUrl(providerConfig);

  const thinkingConfig = resolveThinkingConfig(normalizedModel, reasoningEffort);
  const body = createChatCompletionBody({ messages, model: normalizedModel, thinkingConfig });
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
  maxTokens,
  messages,
  model,
  signal,
  temperature = 0.1,
  reasoningEffort = "quick",
}) {
  const normalizedModel = normalizeQaChatModel(model);
  const providerConfig = getProviderConfig(normalizedModel);

  if (!providerConfig.apiKeyConfigured) {
    throw new QaChatModelError(
      500,
      `${providerConfig.provider}_api_key_missing`,
      `${providerConfig.apiKeyName} is not configured.`,
    );
  }
  assertProviderBaseUrl(providerConfig);
  // Router/controller calls use each model's lightest supported mode. Always-
  // thinking providers must not receive a disabled thinking flag here.
  const body = createChatCompletionBody({
    messages, model: normalizedModel, stream: false, temperature, maxTokens,
    thinkingConfig: resolveThinkingConfig(normalizedModel, reasoningEffort),
  });

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
  assertCompleteAnswer(content, payload?.choices?.[0]?.finish_reason);

  return {
    content: typeof content === "string" ? content : "",
    finishReason: payload?.choices?.[0]?.finish_reason,
    usage: normalizeModelUsage(payload?.usage),
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
  const definition = requireModelDefinition(model);
  return getModelProviderConfig(definition.provider);
}

function assertProviderBaseUrl(config) {
  if (!config.apiBaseUrlConfigured) {
    throw new QaChatModelError(500, `${config.provider}_api_base_url_missing`, "ALIYUN_API_BASE_URL is not configured for the selected region/workspace.");
  }
}

function createChatCompletionBody({
  maxTokens,
  messages,
  model,
  stream = true,
  temperature = 0.2,
  thinkingConfig,
}) {
  return createModelChatBody({
    messages, model, stream, temperature,
    thinking: thinkingConfig, maxTokens: maxTokens ?? getModelMaxTokens(model),
  });
}

async function readOpenAiCompatibleStream(stream, handlers) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasContent = false;
  let finishReason;
  const trackedHandlers = {
    ...handlers,
    onDelta: (text) => { hasContent ||= Boolean(text.trim()); handlers.onDelta?.(text); },
    onFinish: (reason) => { finishReason = reason; handlers.onFinish?.(reason); },
  };

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        processOpenAiCompatibleSseLine(line, trackedHandlers);
      }
    }

    if (buffer.trim()) {
      processOpenAiCompatibleSseLine(buffer, trackedHandlers);
    }
    if (!finishReason) throw new QaChatModelError(502, "qa_incomplete_response", "The model stream ended before completion.");
    assertCompleteAnswer(hasContent ? "content" : "", finishReason);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
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
    throw new QaChatModelError(502, "qa_invalid_stream", "The model returned malformed stream data.");
  }
  if (chunk.error) {
    throw new QaChatModelError(502, "qa_stream_error", chunk.error.message ?? "The model stream returned an error.");
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
    handlers.onUsage?.(normalizeModelUsage(chunk.usage));
  }

  if (finishReason) {
    handlers.onFinish?.(finishReason);
  }
}

function assertCompleteAnswer(content, finishReason) {
  if (finishReason === "length") {
    throw new QaChatModelError(502, "qa_output_truncated", "The model reached its output token limit. Try a lighter reasoning mode or a shorter question.");
  }
  if (finishReason && finishReason !== "stop") {
    throw new QaChatModelError(502, "qa_incomplete_response", "The model did not finish the answer normally.");
  }
  if (typeof content !== "string" || !content.trim()) {
    throw new QaChatModelError(502, "qa_empty_response", "The model returned no answer content.");
  }
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
