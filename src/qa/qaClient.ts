import { getSupabaseAccessToken } from "../auth/supabaseClient";
import { PROJECT_CONFIG } from "../config/projectConfig";
import type {
  QaAnswerStreamRequest,
  QaAgentStep,
  QaCitation,
  QaExecutionMode,
  QaIndexJob,
  QaIndexSource,
  QaMessage,
  QaRetrievalSnapshot,
  QaThread,
  QaToolCall,
  TokenUsage,
} from "../types/domain";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

type QaIndexJobResponse = {
  job: QaIndexJob | null;
};

type CreateQaIndexJobResponse = {
  job: QaIndexJob;
  reused: boolean;
};

type QaThreadsResponse = {
  threads: QaThread[];
};

type QaThreadMessagesResponse = {
  messages: QaMessage[];
};

export type QaStreamHandlers = {
  onAgentStep?: (step: QaAgentStep) => void;
  onCitation?: (citations: QaCitation[]) => void;
  onDelta: (text: string) => void;
  onDone?: (payload: QaDonePayload) => void;
  onFinish?: (finishReason: string) => void;
  onGapCheck?: (step: QaAgentStep) => void;
  onMeta?: (metadata: QaStreamMeta) => void;
  onObservation?: (step: QaAgentStep) => void;
  onRetrieval?: (payload: QaRetrievalPayload) => void;
  onToolCall?: (payload: QaToolCallPayload) => void;
  onUsage?: (usage: TokenUsage) => void;
  onVerifier?: (payload: QaVerifierPayload) => void;
};

export type QaStreamMeta = {
  assistantMessageId: string;
  executionMode: QaExecutionMode;
  model: string;
  promptVersion: string;
  scope: "current";
  threadId: string;
  userMessageId: string;
};

export type QaRetrievalPayload = {
  diagnostics?: unknown;
  snapshot: QaRetrievalSnapshot;
  warnings?: string[];
};

export type QaToolCallPayload = {
  step: QaAgentStep;
  toolCall?: QaToolCall;
};

export type QaVerifierPayload = {
  rejected?: Array<{
    confidence: "rejected";
    evidenceId: string;
    reason: string;
  }>;
  warnings?: string[];
};

export type QaDonePayload = {
  assistantMessage?: QaMessage;
  citations?: QaCitation[];
  threadId: string;
};

export async function getQaIndexJob(cloudDocumentId: string) {
  const response = await fetch(
    `${apiBaseUrl}/qa/index-jobs?documentId=${encodeURIComponent(cloudDocumentId)}`,
    {
      headers: {
        Accept: "application/json",
        ...await getAuthHeader(),
      },
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json() as QaIndexJobResponse;

  return payload.job ?? undefined;
}

export async function createQaIndexJob(input: {
  cloudDocumentId: string;
  source: QaIndexSource;
}) {
  const response = await fetch(`${apiBaseUrl}/qa/index-jobs`, {
    body: JSON.stringify({
      source: input.source,
      userDocumentId: input.cloudDocumentId,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...await getAuthHeader(),
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json() as Promise<CreateQaIndexJobResponse>;
}

export async function getQaThreads(cloudDocumentId: string) {
  const response = await fetch(
    `${apiBaseUrl}/qa/threads?documentId=${encodeURIComponent(cloudDocumentId)}`,
    {
      headers: {
        Accept: "application/json",
        ...await getAuthHeader(),
      },
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json() as QaThreadsResponse;

  return payload.threads;
}

export async function getQaThreadMessages(threadId: string) {
  const response = await fetch(
    `${apiBaseUrl}/qa/threads/${encodeURIComponent(threadId)}/messages`,
    {
      headers: {
        Accept: "application/json",
        ...await getAuthHeader(),
      },
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json() as QaThreadMessagesResponse;

  return payload.messages;
}

export async function deleteQaThread(threadId: string) {
  const response = await fetch(`${apiBaseUrl}/qa/threads/${encodeURIComponent(threadId)}`, {
    headers: {
      Accept: "application/json",
      ...await getAuthHeader(),
    },
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function streamQaAnswer(
  request: QaAnswerStreamRequest,
  handlers: QaStreamHandlers,
  signal?: AbortSignal,
) {
  const requestSignal = createTimeoutSignal(signal);

  try {
    const response = await fetch(`${apiBaseUrl}/qa/stream`, {
      body: JSON.stringify(request),
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        ...await getAuthHeader(),
      },
      method: "POST",
      signal: requestSignal.signal,
    });

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    if (!response.body) {
      throw new Error("QA stream is missing.");
    }

    await readQaEventStream(response.body, handlers);
  } catch (error) {
    if (requestSignal.timedOut()) {
      throw new Error("QA answer timed out. Try a shorter question or fewer follow-up details.");
    }

    throw error;
  } finally {
    requestSignal.dispose();
  }
}

async function getAuthHeader() {
  const accessToken = await getSupabaseAccessToken();

  if (!accessToken) {
    throw new Error("Sign in before using paper QA.");
  }

  return {
    Authorization: `Bearer ${accessToken}`,
  };
}

function createTimeoutSignal(parentSignal?: AbortSignal) {
  const abortController = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, PROJECT_CONFIG.api.qaAnswerTimeoutMs);

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

async function readQaEventStream(
  stream: ReadableStream<Uint8Array>,
  handlers: QaStreamHandlers,
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
    } else if (eventName === "meta") {
      handlers.onMeta?.(payload);
    } else if (eventName === "agent_step") {
      const step = normalizeQaAgentStepPayload(payload);

      if (step) {
        handlers.onAgentStep?.(step);
      }
    } else if (eventName === "tool_call") {
      const toolCallPayload = normalizeQaToolCallPayload(payload);

      if (toolCallPayload) {
        handlers.onToolCall?.(toolCallPayload);
      }
    } else if (eventName === "observation") {
      const step = normalizeQaAgentStepPayload(payload);

      if (step) {
        handlers.onObservation?.(step);
      }
    } else if (eventName === "gap_check") {
      const step = normalizeQaAgentStepPayload(payload);

      if (step) {
        handlers.onGapCheck?.(step);
      }
    } else if (eventName === "retrieval") {
      handlers.onRetrieval?.(payload);
    } else if (eventName === "usage") {
      handlers.onUsage?.(payload);
    } else if (eventName === "finish" && typeof payload.finishReason === "string") {
      handlers.onFinish?.(payload.finishReason);
    } else if (eventName === "citation") {
      handlers.onCitation?.(Array.isArray(payload.citations) ? payload.citations : []);
    } else if (eventName === "verifier") {
      handlers.onVerifier?.(payload);
    } else if (eventName === "done") {
      handlers.onDone?.(payload);
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

function normalizeQaAgentStepPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const step = (payload as { step?: unknown }).step;

  return step && typeof step === "object" ? step as QaAgentStep : undefined;
}

function normalizeQaToolCallPayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const nextPayload = payload as { step?: unknown; toolCall?: unknown };

  if (!nextPayload.step || typeof nextPayload.step !== "object") {
    return undefined;
  }

  return {
    step: nextPayload.step as QaAgentStep,
    toolCall: nextPayload.toolCall && typeof nextPayload.toolCall === "object"
      ? nextPayload.toolCall as QaToolCall
      : undefined,
  };
}

function getStreamErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return "QA request failed.";
  }

  const errorPayload = payload as { message?: unknown };

  return typeof errorPayload.message === "string" && errorPayload.message.trim()
    ? errorPayload.message
    : "QA request failed.";
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
