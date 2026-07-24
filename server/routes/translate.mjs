import { normalizeTranslationLanguagePair } from "../deepseek/languages.mjs";
import {
  assertFreeTranslationSourceWithinLimit,
  buildTranslationMessages,
  getTranslationPromptVersion,
} from "../deepseek/prompt.mjs";
import { writeJson } from "../http/json.mjs";
import {
  createTranslationChatStream,
  normalizeTranslationModel,
  resolveTranslationReasoningConfig,
  TRANSLATION_MODELS,
  TRANSLATION_REASONING_EFFORTS,
  TranslationModelError,
} from "../translationModels/client.mjs";
import { createTranslationReasoningSummary } from "../translationModels/reasoningSummary.mjs";

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_SUMMARY_TRANSLATION_CAPTURE_CHARS = 12_000;

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
  const model = normalizeTranslationModel(requestBody.model);
  const handleResponseClose = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };

  response.once("close", handleResponseClose);

  if (response.destroyed || response.writableEnded) {
    response.off("close", handleResponseClose);
    return;
  }

  try {
    const resolvedReasoning = requestBody.requestKind === "free"
      ? resolveTranslationReasoningConfig(model, {
        effort: requestBody.reasoningEffort,
        enabled: requestBody.reasoningEnabled,
      })
      : undefined;
    const upstreamStream = await createTranslationChatStream({
      messages: buildTranslationMessages(requestBody),
      model,
      resolvedReasoning,
      signal: abortController.signal,
    });

    writeSseHeaders(response);
    writeSse(response, "meta", {
      model,
      promptVersion: getTranslationPromptVersion(requestBody.requestKind),
      reasoning: resolvedReasoning,
    });

    const streamResult = await pipeOpenAiCompatibleStream(upstreamStream, response);

    if (isResponseClosed(response, abortController.signal)) {
      return;
    }

    if (resolvedReasoning?.enabled && streamResult.translationText.trim()) {
      writeSse(response, "reasoning_summary_status", {
        status: "generating",
      });
      writeSse(response, "heartbeat", {});
      const summary = await createTranslationReasoningSummary({
        requestBody,
        signal: abortController.signal,
        translationText: streamResult.translationText,
      });

      if (isResponseClosed(response, abortController.signal)) {
        return;
      }

      writeSse(response, "reasoning_summary", {
        source: summary.source,
        text: summary.text,
      });

      if (summary.usage) {
        writeSse(
          response,
          "usage",
          combineUsage(streamResult.usage, normalizeUsage(summary.usage)),
        );
      }
    }

    if (isResponseClosed(response, abortController.signal)) {
      return;
    }

    writeSse(response, "done", {});
    response.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      if (!response.writableEnded && !response.destroyed) {
        response.end();
      }
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
  } finally {
    response.off("close", handleResponseClose);
  }
}

async function pipeOpenAiCompatibleStream(
  upstreamStream,
  response,
) {
  const reader = upstreamStream.getReader();
  const decoder = new TextDecoder();
  const streamState = {
    lastHeartbeatAt: 0,
    translationText: "",
    usage: undefined,
  };
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
      if (processOpenAiCompatibleSseLine(
        line,
        response,
        streamState,
      )) {
        await reader.cancel().catch(() => undefined);
        return streamState;
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    if (processOpenAiCompatibleSseLine(
      buffer,
      response,
      streamState,
    )) {
      return streamState;
    }
  }

  throw new TranslationModelError(
    502,
    "translation_stream_incomplete",
    "Translation provider stream ended before its completion marker.",
  );
}

function processOpenAiCompatibleSseLine(
  line,
  response,
  streamState,
) {
  if (!line.startsWith("data:")) {
    return false;
  }

  const data = line.slice("data:".length).trim();

  if (!data) {
    return false;
  }

  if (data === "[DONE]") {
    return true;
  }

  let chunk;

  try {
    chunk = JSON.parse(data);
  } catch {
    throw new TranslationModelError(
      502,
      "translation_upstream_stream_invalid",
      "Translation provider returned malformed stream data.",
    );
  }

  if (chunk?.error) {
    throw new TranslationModelError(
      502,
      "translation_upstream_stream_error",
      "Translation provider returned a stream error.",
    );
  }

  const reasoningContent = chunk.choices?.[0]?.delta?.reasoning_content;
  const content = chunk.choices?.[0]?.delta?.content;
  const finishReason = chunk.choices?.[0]?.finish_reason;
  const usage = chunk.usage ?? chunk.choices?.[0]?.usage;

  if (
    typeof reasoningContent === "string" &&
    reasoningContent.length > 0
  ) {
    if (Date.now() - streamState.lastHeartbeatAt >= 5_000) {
      writeSse(response, "heartbeat", {});
      streamState.lastHeartbeatAt = Date.now();
    }
  }

  if (typeof content === "string" && content.length > 0) {
    streamState.translationText = appendBoundedText(
      streamState.translationText,
      content,
      MAX_SUMMARY_TRANSLATION_CAPTURE_CHARS,
    );
    writeSse(response, "delta", { text: content });
  }

  if (usage) {
    streamState.usage = normalizeUsage(usage);
    writeSse(response, "usage", streamState.usage);
  }

  if (finishReason) {
    writeSse(response, "finish", { finishReason });

    if (finishReason !== "stop") {
      throw new TranslationModelError(
        502,
        "translation_stream_truncated",
        `Translation stopped before completion (${finishReason}).`,
      );
    }
  }

  return false;
}

function normalizeTranslationRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }

  if (typeof body.targetSentence !== "string" || body.targetSentence.trim().length === 0) {
    throw new Error("targetSentence is required.");
  }

  const requestKind = body.requestKind === "free" ? "free" : "selection";
  const { sourceLang, targetLang } = normalizeTranslationLanguagePair(
    body.sourceLang,
    body.targetLang,
    { allowAutoSource: requestKind === "free" },
  );

  if (requestKind === "free") {
    assertFreeTranslationSourceWithinLimit(body.targetSentence);
  }

  if (body.model && !TRANSLATION_MODELS.has(body.model)) {
    throw new Error(`Unsupported model: ${body.model}`);
  }

  const model = normalizeTranslationModel(body.model);
  const normalizedRequest = {
    ...body,
    model,
    requestKind,
    sourceLang,
    targetLang,
    terminologyOverride: normalizeTerminologyOverride(body.terminologyOverride),
    translationStyle: normalizeTranslationStyle(body.translationStyle),
  };

  if (requestKind === "free") {
    normalizedRequest.reasoningEnabled = typeof body.reasoningEnabled === "boolean"
      ? body.reasoningEnabled
      : model === "kimi-k3";
    normalizedRequest.reasoningEffort = TRANSLATION_REASONING_EFFORTS.has(
      body.reasoningEffort,
    )
      ? body.reasoningEffort
      : model === "kimi-k3"
        ? "max"
        : "high";
    normalizedRequest.summaryLocale = body.summaryLocale === "zh-CN"
      ? "zh-CN"
      : "en-US";
  } else {
    delete normalizedRequest.reasoningEnabled;
    delete normalizedRequest.reasoningEffort;
    delete normalizedRequest.summaryLocale;
  }

  return normalizedRequest;
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

function normalizeUsage(usage) {
  const promptTokens = normalizeNumber(usage.prompt_tokens ?? usage.promptTokens);
  const promptCacheHitTokens = normalizeNumber(
    usage.prompt_cache_hit_tokens ??
      usage.promptCacheHitTokens ??
      usage.cached_tokens ??
      usage.cachedTokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.promptTokensDetails?.cachedTokens,
  ) ?? (promptTokens === undefined ? undefined : 0);
  const explicitPromptCacheMissTokens = normalizeNumber(
    usage.prompt_cache_miss_tokens ??
      usage.promptCacheMissTokens ??
      usage.prompt_tokens_details?.cache_miss_tokens ??
      usage.promptTokensDetails?.cacheMissTokens,
  );

  return {
    completionTokens: normalizeNumber(usage.completion_tokens ?? usage.completionTokens),
    promptCacheHitTokens,
    promptCacheMissTokens: explicitPromptCacheMissTokens ?? (
      promptTokens === undefined || promptCacheHitTokens === undefined
        ? undefined
        : Math.max(0, promptTokens - promptCacheHitTokens)
    ),
    promptTokens,
    reasoningTokens: normalizeNumber(
      usage.completion_tokens_details?.reasoning_tokens ??
        usage.completionTokensDetails?.reasoningTokens,
    ),
    totalTokens: normalizeNumber(usage.total_tokens ?? usage.totalTokens),
  };
}

function combineUsage(primaryUsage, secondaryUsage) {
  if (!primaryUsage) {
    return secondaryUsage;
  }

  if (!secondaryUsage) {
    return primaryUsage;
  }

  const combined = {};

  for (const key of [
    "completionTokens",
    "promptCacheHitTokens",
    "promptCacheMissTokens",
    "promptTokens",
    "reasoningTokens",
    "totalTokens",
  ]) {
    const primaryValue = primaryUsage[key];
    const secondaryValue = secondaryUsage[key];

    if (primaryValue !== undefined || secondaryValue !== undefined) {
      combined[key] = (primaryValue ?? 0) + (secondaryValue ?? 0);
    }
  }

  return combined;
}

function appendBoundedText(current, text, maxCharacters) {
  const next = `${current}${text}`;

  if (next.length <= maxCharacters) {
    return next;
  }

  const marker = "\n[…]\n";
  const segmentLength = Math.floor((maxCharacters - marker.length) / 2);

  return `${next.slice(0, segmentLength)}${marker}${next.slice(-segmentLength)}`;
}

function isResponseClosed(response, signal) {
  return signal.aborted || response.destroyed || response.writableEnded;
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  if (error instanceof TranslationModelError) {
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
  return error instanceof TranslationModelError ? error.statusCode : 500;
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
