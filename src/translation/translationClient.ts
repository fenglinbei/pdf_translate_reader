import type { TokenUsage, TranslationRequest } from "../types/domain";
import { PROJECT_CONFIG } from "../config/projectConfig";
import { TRANSLATION_TIMEOUT_MESSAGE } from "./errors";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export type TranslationStreamHandlers = {
  onDelta: (text: string) => void;
  onFinish?: (finishReason: string) => void;
  onMeta?: (metadata: { model?: string; promptVersion?: string }) => void;
  onUsage?: (usage: TokenUsage) => void;
};

export async function streamTranslation(
  request: TranslationRequest,
  handlers: TranslationStreamHandlers,
  signal?: AbortSignal,
) {
  const requestSignal = createTimeoutSignal(signal);

  try {
    const response = await fetch(`${apiBaseUrl}/translate/stream`, {
      body: JSON.stringify(request),
      headers: {
        Accept: "text/event-stream",
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

    await readEventStream(response.body, handlers);
  } catch (error) {
    if (requestSignal.timedOut()) {
      throw new Error(TRANSLATION_TIMEOUT_MESSAGE);
    }

    throw error;
  } finally {
    requestSignal.dispose();
  }
}

function createTimeoutSignal(parentSignal?: AbortSignal) {
  const abortController = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, PROJECT_CONFIG.api.translationTimeoutMs);

  function handleParentAbort() {
    abortController.abort();
  }

  if (parentSignal?.aborted) {
    abortController.abort();
  } else {
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  }

  return {
    dispose: () => {
      window.clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", handleParentAbort);
    },
    signal: abortController.signal,
    timedOut: () => timedOut,
  };
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  handlers: TranslationStreamHandlers,
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  function dispatchEvent() {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const payload = JSON.parse(dataLines.join("\n"));

    if (eventName === "delta" && typeof payload.text === "string") {
      handlers.onDelta(payload.text);
    } else if (eventName === "usage") {
      handlers.onUsage?.(payload);
    } else if (eventName === "meta") {
      handlers.onMeta?.(payload);
    } else if (eventName === "finish" && typeof payload.finishReason === "string") {
      handlers.onFinish?.(payload.finishReason);
    } else if (eventName === "error") {
      throw new Error(payload.message ?? "Translation failed.");
    }

    eventName = "message";
    dataLines = [];
  }

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

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
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || `Request failed with status ${response.status}`;
}
