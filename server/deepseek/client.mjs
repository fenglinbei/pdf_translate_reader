import { getDeepSeekRuntimeConfig } from "./config.mjs";

export const DEEPSEEK_MODELS = new Set(["deepseek-v4-flash", "deepseek-v4-pro"]);
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export async function createDeepSeekChatStream({ messages, model, signal }) {
  const config = getDeepSeekRuntimeConfig();

  if (!config.apiKey) {
    throw new DeepSeekClientError(500, "deepseek_api_key_missing", "DEEPSEEK_API_KEY is not configured.");
  }

  const response = await fetch(`${config.apiBaseUrl}/chat/completions`, {
    body: JSON.stringify({
      messages,
      model,
      stream: true,
      stream_options: {
        include_usage: true,
      },
      temperature: 0.2,
      thinking: {
        type: "disabled",
      },
    }),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new DeepSeekClientError(
      response.status,
      "deepseek_api_error",
      parseDeepSeekErrorMessage(body) ?? `DeepSeek API returned ${response.status}.`,
    );
  }

  if (!response.body) {
    throw new DeepSeekClientError(502, "deepseek_stream_missing", "DeepSeek response stream is missing.");
  }

  return response.body;
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
