import { getDeepSeekRuntimeConfig } from "./config.mjs";

export const DEEPSEEK_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export async function createDeepSeekChatStream({
  messages,
  model,
  resolvedReasoning,
  signal,
}) {
  const config = getDeepSeekRuntimeConfig();

  if (!config.apiKey) {
    throw new DeepSeekClientError(500, "deepseek_api_key_missing", "DEEPSEEK_API_KEY is not configured.");
  }

  let response;

  try {
    response = await fetch(`${config.apiBaseUrl}/chat/completions`, {
      body: JSON.stringify(createChatCompletionBody({
        messages,
        model,
        resolvedReasoning,
      })),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    throw new DeepSeekClientError(
      502,
      "deepseek_network_error",
      "Network connection to DeepSeek failed.",
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DeepSeekClientError(
      response.status,
      getDeepSeekErrorCode(response.status),
      parseDeepSeekErrorMessage(body) ?? `DeepSeek API returned ${response.status}.`,
    );
  }

  if (!response.body) {
    throw new DeepSeekClientError(502, "deepseek_stream_missing", "DeepSeek response stream is missing.");
  }

  return response.body;
}

function createChatCompletionBody({ messages, model, resolvedReasoning }) {
  const body = {
    messages,
    model,
    stream: true,
    stream_options: {
      include_usage: true,
    },
  };

  if (resolvedReasoning?.enabled) {
    body.reasoning_effort = resolvedReasoning.effort === "max" ? "max" : "high";
    body.thinking = {
      type: "enabled",
    };
  } else {
    body.temperature = 0.2;
    body.thinking = {
      type: "disabled",
    };
  }

  return body;
}

function getDeepSeekErrorCode(statusCode) {
  if (statusCode === 401 || statusCode === 403) {
    return "deepseek_auth_error";
  }

  if (statusCode === 408 || statusCode === 504) {
    return "deepseek_timeout";
  }

  if (statusCode === 429) {
    return "deepseek_rate_limited";
  }

  if (statusCode >= 500) {
    return "deepseek_server_error";
  }

  return "deepseek_api_error";
}

export class DeepSeekClientError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "DeepSeekClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseDeepSeekErrorMessage(body) {
  if (!body) {
    return undefined;
  }

  try {
    const payload = JSON.parse(body);

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    return body.slice(0, 500);
  }

  return undefined;
}
