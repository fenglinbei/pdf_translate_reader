import { writeJson } from "../http/json.mjs";
import {
  normalizeQaChatModel,
  streamQaChatCompletion,
  QaChatModelError,
} from "../chatModels/client.mjs";
import { verifyAnswerCitations } from "../qa/citationVerifier.mjs";
import {
  recordAgentFallbackStep,
  runCurrentPaperAgenticRetrieval,
  QaAgentRunnerError,
} from "../qa/agentRunner.mjs";
import {
  buildQaAnswerMessages,
  createRetrievalSnapshot,
  QA_PROMPT_VERSION,
} from "../qa/prompt.mjs";
import { retrieveCurrentPaperEvidence } from "../qa/retriever.mjs";
import {
  createOrUpdateIndexJob,
  createOrReuseQaThread,
  getLatestQaIndexJob,
  insertQaApiLog,
  insertQaCitations,
  insertQaMessage,
  listQaMessagesForThread,
  listQaThreadsForDocument,
  updateQaMessage,
} from "../supabase/qa.mjs";
import { SupabaseServiceError } from "../supabase/service.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const QA_INDEX_SOURCES = new Set(["mathpix-v3-pdf"]);
const NO_EVIDENCE_ANSWER_EN = [
  "I could not find indexed evidence in the current paper for this question.",
  "Try rebuilding the QA index after MathPix parsing finishes, or ask with more specific terms from the paper.",
].join(" ");
const NO_EVIDENCE_ANSWER_ZH = "我没有在当前论文索引中找到能支撑这个问题的证据。可以等 MathPix 解析完成后重建 QA 索引，或换用论文中的具体术语再问。";

export async function handleQaRoute(request, response, url, user) {
  try {
    const threadMessagesMatch = url.pathname.match(/^\/api\/qa\/threads\/([^/]+)\/messages$/);

    if (request.method === "GET" && threadMessagesMatch) {
      await handleGetThreadMessages(threadMessagesMatch[1], response, user);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qa/threads") {
      await handleGetThreads(url, response, user);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qa/stream") {
      await handleQaStream(request, response, user);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/qa/index-jobs") {
      await handleGetIndexJob(url, response, user);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qa/index-jobs") {
      await handleCreateIndexJob(request, response, user);
      return;
    }

    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  } catch (error) {
    writeJson(response, getErrorStatusCode(error), {
      error: serializeError(error),
    });
  }
}

async function handleQaStream(request, response, user) {
  const answerStartedAt = Date.now();
  let requestBody;
  let requestThreadId;
  let requestMessageId;
  let requestUsage;
  let requestRetrievalSnapshot;

  try {
    requestBody = normalizeQaStreamRequest(await readJsonBody(request));
  } catch (error) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_stream_request",
        message: error instanceof Error ? error.message : "Invalid QA stream request.",
      },
    });
    return;
  }

  const abortController = new AbortController();
  let assistantMessage;

  response.on("close", () => {
    abortController.abort();
  });

  try {
    const thread = await createOrReuseQaThread({
      activeUserDocumentId: requestBody.activeDocumentId,
      question: requestBody.question,
      threadId: requestBody.threadId,
      userId: user.id,
    });
    requestThreadId = thread.id;

    const userMessage = await insertQaMessage({
      content: requestBody.question,
      role: "user",
      status: "success",
      threadId: thread.id,
      userId: user.id,
    });

    assistantMessage = await insertQaMessage({
      content: "",
      model: requestBody.model,
      promptVersion: QA_PROMPT_VERSION,
      role: "assistant",
      status: "streaming",
      threadId: thread.id,
      userId: user.id,
    });
    requestMessageId = assistantMessage.id;

    writeSseHeaders(response);
    writeSse(response, "meta", {
      assistantMessageId: assistantMessage.id,
      executionMode: requestBody.executionMode,
      model: requestBody.model,
      promptVersion: QA_PROMPT_VERSION,
      scope: requestBody.scope,
      threadId: thread.id,
      userMessageId: userMessage.id,
    });

    const retrievalStartedAt = Date.now();
    let retrieval;
    let agentSteps = [];

    try {
      if (requestBody.executionMode === "agentic") {
        try {
          retrieval = await runCurrentPaperAgenticRetrieval({
            emit: (eventName, payload) => writeSse(response, eventName, payload),
            messageId: assistantMessage.id,
            question: requestBody.question,
            signal: abortController.signal,
            userDocumentId: requestBody.activeDocumentId,
            userId: user.id,
          });
          agentSteps = retrieval.agentSteps ?? [];
        } catch (error) {
          const failedSteps = error instanceof QaAgentRunnerError ? error.agentSteps : [];
          const fallbackStepIndex = error instanceof QaAgentRunnerError ? error.nextStepIndex : failedSteps.length;
          let fallbackStep;

          try {
            fallbackStep = await recordAgentFallbackStep({
              emit: (eventName, payload) => writeSse(response, eventName, payload),
              error,
              messageId: assistantMessage.id,
              stepIndex: fallbackStepIndex,
              userId: user.id,
            });
          } catch (fallbackError) {
            console.warn(
              "QA fallback step write skipped:",
              fallbackError instanceof Error ? fallbackError.message : fallbackError,
            );
          }

          agentSteps = fallbackStep ? [...failedSteps, fallbackStep] : failedSteps;
          retrieval = await retrieveCurrentPaperEvidence({
            question: requestBody.question,
            signal: abortController.signal,
            userDocumentId: requestBody.activeDocumentId,
            userId: user.id,
          });
          retrieval = {
            ...retrieval,
            diagnostics: {
              ...retrieval.diagnostics,
              agent: {
                fallback: true,
                failedMessage: error instanceof Error ? error.message : "Agentic retrieval failed.",
                mode: "agentic",
              },
            },
            warnings: uniqueStrings([
              ...(retrieval.warnings ?? []),
              "Agentic retrieval failed; automatically fell back to single-pass RAG.",
            ]),
          };
        }
      } else {
        retrieval = await retrieveCurrentPaperEvidence({
          question: requestBody.question,
          signal: abortController.signal,
          userDocumentId: requestBody.activeDocumentId,
          userId: user.id,
        });
      }

      await writeQaLogSilent({
        messageId: assistantMessage.id,
        model: requestBody.model,
        payload: {
          diagnostics: retrieval.diagnostics,
          evidenceCount: retrieval.evidence.length,
          queryPlan: retrieval.queryPlan,
          warnings: retrieval.warnings,
        },
        requestFinishedAt: Date.now(),
        requestKind: "retrieval",
        requestStartedAt: retrievalStartedAt,
        retrieverVersion: retrieval.retrieverVersion,
        status: "success",
        threadId: thread.id,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });

      if (retrieval.diagnostics?.rerank) {
        await writeQaLogSilent({
          messageId: assistantMessage.id,
          model: retrieval.diagnostics.rerank.model,
          payload: retrieval.diagnostics.rerank,
          requestFinishedAt: Date.now(),
          requestKind: "rerank",
          requestStartedAt: retrievalStartedAt,
          status: getRerankLogStatus(retrieval.diagnostics.rerank),
          threadId: thread.id,
          usage: retrieval.rerankerUsage,
          userDocumentId: requestBody.activeDocumentId,
          userId: user.id,
        });
      }
    } catch (error) {
      await writeQaLogSilent({
        errorMessage: error instanceof Error ? error.message : "Retrieval failed.",
        messageId: assistantMessage.id,
        model: requestBody.model,
        requestFinishedAt: Date.now(),
        requestKind: "retrieval",
        requestStartedAt: retrievalStartedAt,
        status: "error",
        threadId: thread.id,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });
      throw error;
    }

    const retrievalSnapshot = createRetrievalSnapshot({
      activeDocumentId: requestBody.activeDocumentId,
      evidence: retrieval.evidence,
      queryPlan: retrieval.queryPlan,
      rerankerVersion: retrieval.rerankerVersion,
      retrieverVersion: retrieval.retrieverVersion,
    });
    requestRetrievalSnapshot = retrievalSnapshot;

    writeSse(response, "retrieval", {
      diagnostics: retrieval.diagnostics,
      snapshot: retrievalSnapshot,
      warnings: retrieval.warnings,
    });

    if (retrieval.evidence.length === 0) {
      const noEvidenceAnswer = createNoEvidenceAnswer(requestBody);

      writeSse(response, "delta", { text: noEvidenceAnswer });
      const updatedMessage = await updateQaMessage({
        content: noEvidenceAnswer,
        messageId: assistantMessage.id,
        retrievalSnapshot,
        status: "success",
        userId: user.id,
      });
      await writeQaLogSilent({
        messageId: assistantMessage.id,
        model: requestBody.model,
        payload: {
          evidenceCount: 0,
          warnings: ["No evidence chunks were retrieved for this question."],
        },
        promptVersion: QA_PROMPT_VERSION,
        requestFinishedAt: Date.now(),
        requestKind: "answer-stream",
        requestStartedAt: answerStartedAt,
        retrieverVersion: retrieval.retrieverVersion,
        status: "success",
        threadId: thread.id,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });
      await writeQaLogSilent({
        messageId: assistantMessage.id,
        model: requestBody.model,
        payload: {
          citationCount: 0,
          rejectedCount: 0,
          warnings: ["No evidence chunks were retrieved for this question."],
        },
        promptVersion: QA_PROMPT_VERSION,
        requestFinishedAt: Date.now(),
        requestKind: "citation-verification",
        requestStartedAt: Date.now(),
        status: "success",
        threadId: thread.id,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });

      writeSse(response, "verifier", {
        rejected: [],
        warnings: ["No evidence chunks were retrieved for this question."],
      });
      writeSse(response, "done", {
        assistantMessage: {
          ...updatedMessage,
          agentSteps,
        },
        citations: [],
        threadId: thread.id,
      });
      response.end();
      return;
    }

    let answerText = "";
    let usage;

    await streamQaChatCompletion({
      messages: buildQaAnswerMessages({
        answerLanguage: requestBody.answerLanguage,
        evidence: retrieval.evidence,
        question: requestBody.question,
      }),
      model: requestBody.model,
      onDelta: (text) => {
        answerText += text;
        writeSse(response, "delta", { text });
      },
      onFinish: (finishReason) => {
        writeSse(response, "finish", { finishReason });
      },
      onUsage: (nextUsage) => {
        usage = nextUsage;
        requestUsage = nextUsage;
        writeSse(response, "usage", nextUsage);
      },
      signal: abortController.signal,
    });

    const citationVerificationStartedAt = Date.now();
    const verification = verifyAnswerCitations({
      answerText,
      evidence: retrieval.evidence,
    });
    const savedCitations = await insertQaCitations({
      citations: verification.citations,
      messageId: assistantMessage.id,
      userId: user.id,
    });
    await writeQaLogSilent({
      messageId: assistantMessage.id,
      model: requestBody.model,
      payload: {
        citationCount: savedCitations.length,
        rejectedCount: verification.rejected.length,
        warnings: verification.warnings,
      },
      promptVersion: QA_PROMPT_VERSION,
      requestFinishedAt: Date.now(),
      requestKind: "citation-verification",
      requestStartedAt: citationVerificationStartedAt,
      status: "success",
      threadId: thread.id,
      userDocumentId: requestBody.activeDocumentId,
      userId: user.id,
    });
    const updatedMessage = await updateQaMessage({
      content: answerText,
      messageId: assistantMessage.id,
      retrievalSnapshot,
      status: "success",
      usage,
      userId: user.id,
    });
    await writeQaLogSilent({
      messageId: assistantMessage.id,
      model: requestBody.model,
      payload: {
        citationCount: savedCitations.length,
        evidenceCount: retrieval.evidence.length,
        verifierWarnings: verification.warnings,
      },
      promptVersion: QA_PROMPT_VERSION,
      requestFinishedAt: Date.now(),
      requestKind: "answer-stream",
      requestStartedAt: answerStartedAt,
      retrieverVersion: retrieval.retrieverVersion,
      status: "success",
      threadId: thread.id,
      usage,
      userDocumentId: requestBody.activeDocumentId,
      userId: user.id,
    });

    writeSse(response, "citation", { citations: savedCitations });
    writeSse(response, "verifier", {
      rejected: verification.rejected,
      warnings: verification.warnings,
    });
    writeSse(response, "done", {
      assistantMessage: {
        ...updatedMessage,
        agentSteps,
        citations: savedCitations,
      },
      citations: savedCitations,
      threadId: thread.id,
    });
    response.end();
  } catch (error) {
    if (abortController.signal.aborted) {
      if (assistantMessage?.id) {
        await updateQaMessage({
          errorMessage: "Request was aborted.",
          messageId: assistantMessage.id,
          status: "aborted",
          userId: user.id,
        }).catch(() => undefined);
      }
      await writeQaLogSilent({
        errorMessage: "Request was aborted.",
        messageId: assistantMessage?.id ?? requestMessageId,
        model: requestBody?.model,
        payload: {
          retrievalSnapshot: requestRetrievalSnapshot,
        },
        promptVersion: QA_PROMPT_VERSION,
        requestFinishedAt: Date.now(),
        requestKind: "answer-stream",
        requestStartedAt: answerStartedAt,
        status: "aborted",
        threadId: requestThreadId,
        usage: requestUsage,
        userDocumentId: requestBody?.activeDocumentId,
        userId: user.id,
      });

      response.end();
      return;
    }

    if (assistantMessage?.id) {
      await updateQaMessage({
        errorMessage: error instanceof Error ? error.message : "QA request failed.",
        messageId: assistantMessage.id,
        status: "error",
        userId: user.id,
      }).catch(() => undefined);
    }
    await writeQaLogSilent({
      errorMessage: error instanceof Error ? error.message : "QA request failed.",
      messageId: assistantMessage?.id ?? requestMessageId,
      model: requestBody?.model,
      payload: {
        retrievalSnapshot: requestRetrievalSnapshot,
      },
      promptVersion: QA_PROMPT_VERSION,
      requestFinishedAt: Date.now(),
      requestKind: "answer-stream",
      requestStartedAt: answerStartedAt,
      status: "error",
      threadId: requestThreadId,
      usage: requestUsage,
      userDocumentId: requestBody?.activeDocumentId,
      userId: user.id,
    });

    if (response.headersSent) {
      writeSse(response, "error", serializeError(error));
      response.end();
      return;
    }

    writeJson(response, getErrorStatusCode(error), {
      error: serializeError(error),
    });
  }
}

async function handleGetThreads(url, response, user) {
  const userDocumentId = normalizeUuidLike(url.searchParams.get("documentId"));

  if (!userDocumentId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_threads_request",
        message: "documentId is required.",
      },
    });
    return;
  }

  const threads = await listQaThreadsForDocument({
    userDocumentId,
    userId: user.id,
  });

  writeJson(response, 200, { threads });
}

async function handleGetThreadMessages(threadIdPathSegment, response, user) {
  const threadId = normalizeUuidLike(decodeURIComponent(threadIdPathSegment));

  if (!threadId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_thread_messages_request",
        message: "threadId is required.",
      },
    });
    return;
  }

  const messages = await listQaMessagesForThread({
    threadId,
    userId: user.id,
  });

  writeJson(response, 200, { messages });
}

async function handleGetIndexJob(url, response, user) {
  const userDocumentId = normalizeUuidLike(url.searchParams.get("documentId"));

  if (!userDocumentId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: "documentId is required.",
      },
    });
    return;
  }

  const job = await getLatestQaIndexJob({
    userDocumentId,
    userId: user.id,
  });

  writeJson(response, 200, {
    job: job ?? null,
  });
}

async function handleCreateIndexJob(request, response, user) {
  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: error instanceof Error ? error.message : "Invalid QA index job request.",
      },
    });
    return;
  }

  const userDocumentId = normalizeUuidLike(body?.userDocumentId);
  const source = typeof body?.source === "string" ? body.source : undefined;

  if (!userDocumentId || !source) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: "userDocumentId and source are required.",
      },
    });
    return;
  }

  if (!QA_INDEX_SOURCES.has(source)) {
    writeJson(response, 400, {
      error: {
        code: "qa_index_source_not_supported",
        message: "PDF text indexing is not supported yet. Start MathPix parsing first, then build the MathPix index.",
      },
    });
    return;
  }

  const result = await createOrUpdateIndexJob({
    source,
    userDocumentId,
    userId: user.id,
  });

  writeJson(response, result.reused ? 200 : 201, result);
}

function normalizeQaStreamRequest(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body must be an object.");
  }

  const question = typeof body.question === "string"
    ? body.question.replace(/\s+/g, " ").trim()
    : "";
  const activeDocumentId = normalizeUuidLike(
    body.activeDocumentId ?? body.activeUserDocumentId ?? body.userDocumentId,
  );
  const threadId = normalizeUuidLike(body.threadId);

  if (!question) {
    throw new Error("question is required.");
  }

  if (!activeDocumentId) {
    throw new Error("activeDocumentId is required.");
  }

  return {
    activeDocumentId,
    answerLanguage: normalizeAnswerLanguage(body.answerLanguage),
    executionMode: normalizeExecutionMode(body.executionMode),
    model: normalizeQaChatModel(body.model),
    question: question.slice(0, 2000),
    scope: normalizeQaScope(body.scope),
    threadId,
  };
}

function normalizeAnswerLanguage(value) {
  return value === "zh" || value === "en" ? value : "auto";
}

function normalizeExecutionMode(value) {
  return value === "rag" ? "rag" : "agentic";
}

function normalizeQaScope(value) {
  if (value && value !== "current") {
    throw new Error("Only current-paper QA scope is supported in this milestone.");
  }

  return "current";
}

function createNoEvidenceAnswer(requestBody) {
  if (
    requestBody.answerLanguage === "zh" ||
    (requestBody.answerLanguage === "auto" && /[\u3400-\u9fff]/.test(requestBody.question))
  ) {
    return NO_EVIDENCE_ANSWER_ZH;
  }

  return NO_EVIDENCE_ANSWER_EN;
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

  if (chunks.length === 0) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function getRerankLogStatus(diagnostics) {
  return diagnostics?.skippedReason === "reranker_failed" ? "error" : "success";
}

async function writeQaLogSilent(input) {
  try {
    await insertQaApiLog(input);
  } catch (error) {
    console.warn("QA API log write skipped:", error instanceof Error ? error.message : error);
  }
}

function normalizeUuidLike(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeError(error) {
  if (error instanceof QaChatModelError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (error instanceof SupabaseServiceError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: "qa_route_error",
    message: error instanceof Error ? error.message : "QA request failed.",
  };
}

function getErrorStatusCode(error) {
  if (error instanceof SupabaseServiceError || error instanceof QaChatModelError) {
    return error.statusCode;
  }

  return 500;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}
