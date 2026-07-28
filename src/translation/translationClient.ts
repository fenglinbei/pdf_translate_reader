import type {
  TokenUsage,
  TranslationReasoningEffort,
  TranslationStreamRequest,
} from "../types/domain";
import {
  isTranslationLanguage,
  type TranslationLanguage,
} from "../config/translationLanguages";
import { PROJECT_CONFIG } from "../config/projectConfig";
import { getSupabaseAccessToken } from "../auth/supabaseClient";
import { TranslationNetworkError, TranslationTimeoutError } from "./errors";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type TranslationProgressPhase =
  | "accepted"
  | "connecting"
  | "analyzing"
  | "translating"
  | "finalizing_summary"
  | "complete";

export type TranslationReasoningSummaryDelta = {
  revision: number;
  seq: number;
  text: string;
};

export type TranslationReasoningSummarySnapshot = {
  final: boolean;
  revision: number;
  source?: string;
  text: string;
};

export type TranslationThinkingPart = {
  complete: boolean;
  firstSeq: number;
  partId: string;
  text: string;
};

export type TranslationThinkingTimeline = {
  lastSeq: number;
  parts: TranslationThinkingPart[];
};

export type TranslationThinkingTimelineEvent =
  | {
    kind: "part_added";
    partId: string;
    seq: number;
  }
  | {
    delta: string;
    kind: "text_delta";
    partId: string;
    seq: number;
  }
  | {
    kind: "text_done";
    partId: string;
    seq: number;
    text: string;
  };

export type TranslationDetectedSourceLanguage = {
  confidence?: number;
  language: TranslationLanguage;
  source?: string;
};

export type TranslationStreamHandlers = {
  onDelta: (text: string) => void;
  onDetectedSourceLanguage?: (
    detected: TranslationDetectedSourceLanguage,
  ) => void;
  onFinish?: (finishReason: string) => void;
  onMeta?: (metadata: {
    model?: string;
    promptVersion?: string;
    reasoning?: {
      effort: TranslationReasoningEffort;
      enabled: boolean;
      forced: boolean;
      requestedEnabled: boolean;
    };
  }) => void;
  onProgress?: (phase: TranslationProgressPhase) => void;
  onReasoningSummary?: (
    text: string,
    snapshot: TranslationReasoningSummarySnapshot,
  ) => void;
  onReasoningSummaryDelta?: (delta: TranslationReasoningSummaryDelta) => void;
  onReasoningSummaryStatus?: (status: "generating") => void;
  onThinkingCompleted?: (completed: {
    degraded: boolean;
    durationMs: number;
    partCount?: number;
  }) => void;
  onThinkingStarted?: (started: { startedAt?: number }) => void;
  onThinkingSummaryPartAdded?: (part: {
    partId: string;
    seq: number;
    source?: string;
  }) => void;
  onThinkingSummaryTextDelta?: (delta: {
    delta: string;
    partId: string;
    seq: number;
  }) => void;
  onThinkingSummaryTextDone?: (part: {
    partId: string;
    seq: number;
    text: string;
  }) => void;
  onTranslationComplete?: (finishReason: string) => void;
  onUsage?: (usage: TokenUsage) => void;
};

export function createTranslationThinkingTimeline(): TranslationThinkingTimeline {
  return {
    lastSeq: 0,
    parts: [],
  };
}

export function reduceTranslationThinkingTimeline(
  current: TranslationThinkingTimeline,
  event: TranslationThinkingTimelineEvent,
): TranslationThinkingTimeline {
  if (
    !event.partId.trim() ||
    !Number.isInteger(event.seq) ||
    event.seq <= current.lastSeq
  ) {
    return current;
  }

  const partIndex = current.parts.findIndex((part) => part.partId === event.partId);
  const existingPart = partIndex >= 0 ? current.parts[partIndex] : undefined;
  const nextPart: TranslationThinkingPart = existingPart
    ? { ...existingPart }
    : {
      complete: false,
      firstSeq: event.seq,
      partId: event.partId,
      text: "",
    };

  if (event.kind === "text_delta" && !nextPart.complete) {
    nextPart.text += event.delta;
  } else if (event.kind === "text_done") {
    nextPart.complete = true;
    nextPart.text = event.text || nextPart.text;
  }

  const parts = [...current.parts];

  if (partIndex >= 0) {
    parts[partIndex] = nextPart;
  } else {
    parts.push(nextPart);
    parts.sort((left, right) => left.firstSeq - right.firstSeq);
  }

  return {
    lastSeq: event.seq,
    parts,
  };
}

export function completeTranslationThinkingTimeline(
  current: TranslationThinkingTimeline,
): TranslationThinkingTimeline {
  if (current.parts.every((part) => part.complete)) {
    return current;
  }

  return {
    ...current,
    parts: current.parts.map((part) => ({
      ...part,
      complete: true,
    })),
  };
}

export function getTranslationThinkingText(
  timeline: TranslationThinkingTimeline,
) {
  return timeline.parts
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export async function streamTranslation(
  request: TranslationStreamRequest,
  handlers: TranslationStreamHandlers,
  signal?: AbortSignal,
) {
  const requestSignal = createTimeoutSignal(signal);

  try {
    const accessToken = await getSupabaseAccessToken();

    if (!accessToken) {
      throw new Error("Sign in before translating.");
    }

    const response = await fetch(`${apiBaseUrl}/translate/stream`, {
      body: JSON.stringify(request),
      headers: {
        Accept: "text/event-stream",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: requestSignal.signal,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    if (!response.body) {
      throw new Error("Translation stream is missing.");
    }

    requestSignal.touch();
    await readEventStream(response.body, handlers, requestSignal.touch);
  } catch (error) {
    if (requestSignal.timedOut()) {
      throw new TranslationTimeoutError();
    }

    if (isNetworkFetchError(error)) {
      throw new TranslationNetworkError();
    }

    throw error;
  } finally {
    requestSignal.dispose();
  }
}

function isNetworkFetchError(error: unknown) {
  return error instanceof TypeError && error.message.toLocaleLowerCase().includes("fetch");
}

function createTimeoutSignal(parentSignal?: AbortSignal) {
  const abortController = new AbortController();
  let timedOut = false;
  let timeoutId: number | undefined;

  function scheduleTimeout() {
    if (abortController.signal.aborted) {
      return;
    }

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }

    timeoutId = window.setTimeout(() => {
      if (abortController.signal.aborted) {
        return;
      }

      timedOut = true;
      abortController.abort();
    }, PROJECT_CONFIG.api.translationTimeoutMs);
  }

  function handleParentAbort() {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutId = undefined;
    }

    abortController.abort();
  }

  if (parentSignal?.aborted) {
    abortController.abort();
  } else {
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
    scheduleTimeout();
  }

  return {
    dispose: () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      parentSignal?.removeEventListener("abort", handleParentAbort);
    },
    signal: abortController.signal,
    timedOut: () => timedOut,
    touch: scheduleTimeout,
  };
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  handlers: TranslationStreamHandlers,
  onActivity: () => void,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  let finishReason: string | undefined;
  let receivedDone = false;

  function dispatchEvent() {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const payload = JSON.parse(dataLines.join("\n"));

    if (eventName === "delta" && typeof payload.text === "string") {
      handlers.onDelta(payload.text);
    } else if (
      eventName === "source_language" &&
      isTranslationLanguage(payload.language)
    ) {
      handlers.onDetectedSourceLanguage?.({
        confidence: typeof payload.confidence === "number" &&
            Number.isFinite(payload.confidence)
          ? payload.confidence
          : undefined,
        language: payload.language,
        source: typeof payload.source === "string" ? payload.source : undefined,
      });
    } else if (
      eventName === "progress" &&
      isTranslationProgressPhase(payload.phase)
    ) {
      handlers.onProgress?.(payload.phase);
    } else if (
      eventName === "reasoning_summary_delta" &&
      Number.isInteger(payload.revision) &&
      payload.revision > 0 &&
      Number.isInteger(payload.seq) &&
      payload.seq > 0 &&
      typeof payload.text === "string"
    ) {
      handlers.onReasoningSummaryDelta?.({
        revision: payload.revision,
        seq: payload.seq,
        text: payload.text,
      });
    } else if (
      eventName === "reasoning_summary" &&
      typeof payload.text === "string"
    ) {
      handlers.onReasoningSummary?.(payload.text, {
        final: payload.final !== false,
        revision: Number.isInteger(payload.revision) && payload.revision > 0
          ? payload.revision
          : 2,
        source: typeof payload.source === "string" ? payload.source : undefined,
        text: payload.text,
      });
    } else if (
      eventName === "reasoning_summary_status" &&
      payload.status === "generating"
    ) {
      handlers.onReasoningSummaryStatus?.("generating");
    } else if (eventName === "thinking_started") {
      handlers.onThinkingStarted?.({
        startedAt: typeof payload.startedAt === "number" &&
            Number.isFinite(payload.startedAt)
          ? payload.startedAt
          : undefined,
      });
    } else if (
      eventName === "thinking_summary_part_added" &&
      isThinkingSequencePayload(payload)
    ) {
      handlers.onThinkingSummaryPartAdded?.({
        partId: payload.partId,
        seq: payload.seq,
        source: typeof payload.source === "string" ? payload.source : undefined,
      });
    } else if (
      eventName === "thinking_summary_text_delta" &&
      isThinkingSequencePayload(payload) &&
      typeof payload.delta === "string"
    ) {
      handlers.onThinkingSummaryTextDelta?.({
        delta: payload.delta,
        partId: payload.partId,
        seq: payload.seq,
      });
    } else if (
      eventName === "thinking_summary_text_done" &&
      isThinkingSequencePayload(payload) &&
      typeof payload.text === "string"
    ) {
      handlers.onThinkingSummaryTextDone?.({
        partId: payload.partId,
        seq: payload.seq,
        text: payload.text,
      });
    } else if (
      eventName === "thinking_completed" &&
      typeof payload.durationMs === "number" &&
      Number.isFinite(payload.durationMs) &&
      payload.durationMs >= 0
    ) {
      handlers.onThinkingCompleted?.({
        degraded: payload.degraded === true,
        durationMs: payload.durationMs,
        partCount: Number.isInteger(payload.partCount) && payload.partCount >= 0
          ? payload.partCount
          : undefined,
      });
    } else if (
      eventName === "translation_complete" &&
      typeof payload.finishReason === "string"
    ) {
      handlers.onTranslationComplete?.(payload.finishReason);
    } else if (eventName === "usage") {
      handlers.onUsage?.(payload);
    } else if (eventName === "meta") {
      handlers.onMeta?.(payload);
    } else if (eventName === "finish" && typeof payload.finishReason === "string") {
      finishReason = payload.finishReason;
      handlers.onFinish?.(payload.finishReason);
    } else if (eventName === "done") {
      if (finishReason && finishReason !== "stop") {
        throw new Error(`Translation stopped before completion (${finishReason}).`);
      }

      receivedDone = true;
    } else if (eventName === "error") {
      throw new Error(getStreamErrorMessage(payload));
    }

    eventName = "message";
    dataLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    onActivity();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
        dispatchEvent();
      } else if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
  }

  dispatchEvent();

  if (!receivedDone) {
    throw new Error("Translation stream ended unexpectedly.");
  }
}

function isThinkingSequencePayload(
  payload: unknown,
): payload is Record<string, unknown> & { partId: string; seq: number } {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const candidate = payload as { partId?: unknown; seq?: unknown };

  return typeof candidate.partId === "string" &&
    Boolean(candidate.partId.trim()) &&
    Number.isInteger(candidate.seq) &&
    Number(candidate.seq) > 0;
}

function isTranslationProgressPhase(value: unknown): value is TranslationProgressPhase {
  return value === "accepted" ||
    value === "connecting" ||
    value === "analyzing" ||
    value === "translating" ||
    value === "finalizing_summary" ||
    value === "complete";
}

function getStreamErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "Translation failed.";
  }

  const errorPayload = payload as { code?: unknown; message?: unknown };
  const errorCode = typeof errorPayload.code === "string" ? errorPayload.code : undefined;
  const providerMessage = getProviderErrorMessage(errorCode);

  if (providerMessage) {
    return providerMessage;
  }

  return typeof errorPayload.message === "string" ? errorPayload.message : "Translation failed.";
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();
    const errorCode = typeof payload?.error?.code === "string" ? payload.error.code : undefined;
    const providerMessage = getProviderErrorMessage(errorCode);

    if (providerMessage) {
      return providerMessage;
    }

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || `Request failed with status ${response.status}`;
}

function getProviderErrorMessage(errorCode?: string) {
  if (!errorCode) {
    return undefined;
  }

  const providerName = errorCode.startsWith("glm_")
    ? "GLM"
    : errorCode.startsWith("kimi_")
      ? "Kimi"
      : errorCode.startsWith("deepseek_")
        ? "DeepSeek"
        : "Translation provider";

  if (errorCode.endsWith("_rate_limited")) {
    return `${providerName} rate limit or quota was reached. Wait a moment, then try again.`;
  }

  if (errorCode.endsWith("_auth_error") || errorCode.endsWith("_api_key_missing")) {
    return `${providerName} API key is missing or invalid. Check the local API configuration.`;
  }

  if (errorCode.endsWith("_network_error")) {
    return "Network connection failed. Check the API proxy and internet connection.";
  }

  return undefined;
}
