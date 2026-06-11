import {
  createDeepSeekChatStream,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_MODELS,
  DeepSeekClientError,
} from "../deepseek/client.mjs";
import { normalizeTranslationLanguagePair } from "../deepseek/languages.mjs";
import { buildTranslationMessages, TRANSLATION_PROMPT_VERSION } from "../deepseek/prompt.mjs";
import { writeJson } from "../http/json.mjs";

const MAX_REQUEST_BYTES = 256 * 1024;

export async function handleTranslateStream(request, response) {
  let requestBody;

  try {
    requestBody = await readJsonBody(request);
    requestBody = normalizeTranslationRequest(requestBody);
  } catch (error) {
    writeJson(response, 400, {
      error: {
        code: "invalid_translation_request",
        message: error instanceof Error ? error.message : "Invalid translation request.",
      },
    });
    return;
  }

  const abortController = new AbortController();
  const model = normalizeModel(requestBody.model);

  request.on("close", () => {
    abortController.abort();
  });

  try {
    const upstreamStream = await createDeepSeekChatStream({
      messages: buildTranslationMessages(requestBody),
      model,
      signal: abortController.signal,
    });

    writeSseHeaders(response);
    writeSse(response, "meta", {
      model,
      promptVersion: TRANSLATION_PROMPT_VERSION,
    });

    await pipeDeepSeekStream(upstreamStream, response);
    writeSse(response, "done", {});
    response.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      response.end();
      return;
    }

    if (response.headersSent) {
      writeSse(response, "error", serializeError(error));
      response.end();
      return;
    }

    const serializedError = serializeError(error);
    writeJson(response, getErrorStatusCode(error), {
      error: serializedError,
    });
  }
}

async function pipeDeepSeekStream(upstreamStream, response) {
  const reader = upstreamStream.getReader();
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
      processDeepSeekSseLine(line, response);
    }
  }

  if (buffer.trim()) {
    processDeepSeekSseLine(buffer, response);
  }
}

function processDeepSeekSseLine(line, response) {
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
    writeSse(response, "delta", { text: content });
  }

  if (chunk.usage) {
    writeSse(response, "usage", normalizeUsage(chunk.usage));
  }

  if (finishReason) {
    writeSse(response, "finish", { finishReason });
  }
}

function normalizeTranslationRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }

  if (typeof body.targetSentence !== "string" || body.targetSentence.trim().length === 0) {
    throw new Error("targetSentence is required.");
  }

  const { sourceLang, targetLang } = normalizeTranslationLanguagePair(
    body.sourceLang,
    body.targetLang,
  );

  if (body.model && !DEEPSEEK_MODELS.has(body.model)) {
    throw new Error(`Unsupported model: ${body.model}`);
  }

  return {
    ...body,
    requestKind: body.requestKind === "free" ? "free" : "selection",
    sourceLang,
    targetLang,
    terminologyOverride: normalizeTerminologyOverride(body.terminologyOverride),
    translationStyle: normalizeTranslationStyle(body.translationStyle),
  };
}

function normalizeTranslationStyle(value) {
  const presetId = isTranslationStylePresetId(value?.presetId)
    ? value.presetId
    : "academic-faithful";

  if (presetId !== "custom") {
    return { presetId };
  }

  const customInstruction = typeof value?.customInstruction === "string"
    ? value.customInstruction.replace(/\s+/g, " ").trim().slice(0, 800).trim()
    : "";

  return customInstruction
    ? { customInstruction, presetId }
    : { presetId: "academic-faithful" };
}

function isTranslationStylePresetId(value) {
  return [
    "academic-faithful",
    "academic-fluent",
    "concise-literal",
    "publication-polished",
    "reader-friendly",
    "custom",
  ].includes(value);
}

function normalizeTerminologyOverride(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((term) => ({
      confidence: term?.confidence === "auto" ? "auto" : "user",
      source: cleanOptionalText(term?.source, 120),
      target: cleanOptionalText(term?.target, 120),
      updatedAt: Number.isFinite(term?.updatedAt) ? term.updatedAt : Date.now(),
    }))
    .filter((term) => term.source && term.target)
    .slice(0, 80);
}

function cleanOptionalText(value, maxLength) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

  return text ? text.slice(0, maxLength).trim() : undefined;
}

function normalizeModel(model) {
  return DEEPSEEK_MODELS.has(model) ? model : DEFAULT_DEEPSEEK_MODEL;
}

function normalizeUsage(usage) {
  return {
    completionTokens: usage.completion_tokens,
    promptCacheHitTokens: usage.prompt_cache_hit_tokens,
    promptCacheMissTokens: usage.prompt_cache_miss_tokens,
    promptTokens: usage.prompt_tokens,
    totalTokens: usage.total_tokens,
  };
}

function writeSseHeaders(response) {
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
  });
}

function writeSse(response, eventName, payload) {
  response.write(`event: ${eventName}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function serializeError(error) {
  if (error instanceof DeepSeekClientError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: "translation_stream_error",
    message: error instanceof Error ? error.message : "Translation failed.",
  };
}

function getErrorStatusCode(error) {
  return error instanceof DeepSeekClientError ? error.statusCode : 500;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
