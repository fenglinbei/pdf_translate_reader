import { writeJson } from "../http/json.mjs";
import {
  normalizeQaChatModel,
  streamQaChatCompletion,
  QaChatModelError,
} from "../chatModels/client.mjs";
import { EmbeddingProviderError } from "../embedding/client.mjs";
import { verifyAnswerCitations } from "../qa/citationVerifier.mjs";
import {
  runCurrentPaperReasoningRetrieval,
} from "../qa/agentRunner.mjs";
import { RerankerProviderError } from "../qa/reranker.mjs";
import { classifyQuestionType } from "../qa/queryRouter.mjs";
import {
  buildQaAnswerMessages,
  createRetrievalSnapshot,
  QA_PROMPT_VERSION,
} from "../qa/prompt.mjs";
import { computeAnswerContextBudget } from "../qa/contextBudget.mjs";
import { loadCurrentPaperFullText } from "../qa/retriever.mjs";
import {
  createOrUpdateIndexJob,
  createOrReuseQaThread,
  deleteQaMessage,
  deleteQaThread,
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
const QA_CONTEXT_MAX_MESSAGES = 12;
const QA_CONTEXT_MAX_MESSAGE_CHARS = 4000;
const QA_CONTEXT_MAX_CARRYOVER_EVIDENCE = 20;
const QA_INDEX_SOURCES = new Set(["mathpix-v3-pdf"]);
const NO_EVIDENCE_ANSWER_EN = [
  "I could not find indexed evidence in the current paper for this question.",
  "Try rebuilding the QA index after MathPix parsing finishes, or ask with more specific terms from the paper.",
].join(" ");
const NO_EVIDENCE_ANSWER_ZH = "我没有在当前论文索引中找到能支撑这个问题的证据。可以等 MathPix 解析完成后重建 QA 索引，或换用论文中的具体术语再问。";

export async function handleQaRoute(request, response, url, user) {
  try {
    const threadMatch = url.pathname.match(/^\/api\/qa\/threads\/([^/]+)$/);
    const threadMessagesMatch = url.pathname.match(/^\/api\/qa\/threads\/([^/]+)\/messages$/);
    const messageMatch = url.pathname.match(/^\/api\/qa\/messages\/([^/]+)$/);

    if (request.method === "DELETE" && messageMatch) {
      await handleDeleteMessage(messageMatch[1], response, user);
      return;
    }

    if (request.method === "DELETE" && threadMatch) {
      await handleDeleteThread(threadMatch[1], response, user);
      return;
    }

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

    const previousMessages = await listQaMessagesForThread({
      threadId: thread.id,
      userId: user.id,
    });
    const chatContext = buildQaChatContext({
      activeDocumentId: requestBody.activeDocumentId,
      messages: previousMessages,
      question: requestBody.question,
    });

    // In regenerate mode, delete the old assistant message and reuse the
    // existing user message instead of inserting a duplicate user turn.
    let userMessageId;
    if (requestBody.regenerateMessageId) {
      await deleteQaMessage({
        messageId: requestBody.regenerateMessageId,
        userId: user.id,
      });
      // The user message is the most recent non-deleted user turn before the
      // regenerated assistant message; reuse it.
      const priorMessages = await listQaMessagesForThread({
        threadId: thread.id,
        userId: user.id,
      });
      const lastUserMessage = [...priorMessages]
        .reverse()
        .find((message) => message.role === "user");
      userMessageId = lastUserMessage?.id;
    }

    if (!requestBody.regenerateMessageId) {
      const userMessage = await insertQaMessage({
        content: requestBody.question,
        role: "user",
        status: "success",
        threadId: thread.id,
        userId: user.id,
      });
      userMessageId = userMessage.id;
    }

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
      reasoningEffort: requestBody.reasoningEffort,
      scope: requestBody.scope,
      threadId: thread.id,
      userMessageId: userMessageId,
    });

    const retrievalStartedAt = Date.now();
    let retrieval;
    let agentSteps = [];

    const questionType = await classifyQuestionType({
      chatContext,
      model: requestBody.model,
      question: requestBody.question,
      signal: abortController.signal,
    });

    console.log("[qa-stream] questionType =", questionType.type, "| question:", String(requestBody.question ?? "").slice(0, 60));

    if (questionType.type === "global") {
      console.log("[qa-stream] -> long context path");
      try {
        await handleLongContextAnswer({
          abortController,
          agentSteps,
          answerLanguage: requestBody.answerLanguage,
          assistantMessageId: assistantMessage.id,
          chatContext,
          model: requestBody.model,
          question: requestBody.question,
          questionType,
          reasoningEffort: requestBody.reasoningEffort,
          response,
          threadId: thread.id,
          userDocumentId: requestBody.activeDocumentId,
          userId: user.id,
        });
        return;
      } catch (error) {
        try {
          writeSse(response, "agent_step", {
            step: {
              kind: "fallback",
              messageId: assistantMessage.id,
              payload: {
                errorMessage: error instanceof Error ? error.message : "Long-context answering failed.",
                reason: "long_context_failed",
              },
              status: "error",
              stepIndex: 0,
              summary: "长上下文回答失败，已退回 agentic 检索。",
            },
          });
        } catch {
          // writeSse is best-effort here; ignore failures so we still fall through.
        }
        // fall through to agentic retrieval below
      }
    }

    try {
      retrieval = await runCurrentPaperReasoningRetrieval({
        emit: (eventName, payload) => writeSse(response, eventName, payload),
        messageId: assistantMessage.id,
        model: requestBody.model,
        question: requestBody.question,
        reasoningEffort: requestBody.reasoningEffort,
        signal: abortController.signal,
        chatContext,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });
      agentSteps = retrieval.agentSteps ?? [];

      await writeQaLogSilent({
        messageId: assistantMessage.id,
        model: requestBody.model,
        payload: {
          chatContext: summarizeQaChatContextForLog(chatContext),
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

    if (retrieval.diagnostics?.agent?.directAnswer) {
      let directAnswerText = "";
      let directUsage;

      await streamQaChatCompletion({
        messages: buildQaAnswerMessages({
          answerLanguage: requestBody.answerLanguage,
          budget: computeAnswerContextBudget({ model: requestBody.model, mode: "direct" }),
          chatContext,
          directReplyOutline: retrieval.diagnostics.agent.directAnswerReason,
          evidence: [],
          mode: "direct",
          question: requestBody.question,
        }),
        model: requestBody.model,
        reasoningEffort: requestBody.reasoningEffort,
        onDelta: (text) => {
          directAnswerText += text;
          writeSse(response, "delta", { text });
        },
        onThinking: (text) => {
          writeSse(response, "thinking", { text });
        },
        onFinish: (finishReason) => {
          writeSse(response, "finish", { finishReason });
        },
        onUsage: (usage) => {
          directUsage = usage;
          writeSse(response, "usage", { usage });
        },
        signal: abortController.signal,
      });

      const updatedMessage = await updateQaMessage({
        content: directAnswerText,
        messageId: assistantMessage.id,
        retrievalSnapshot,
        status: "success",
        userId: user.id,
      });
      await writeQaLogSilent({
        messageId: assistantMessage.id,
        model: requestBody.model,
        payload: {
          directAnswer: true,
          directAnswerReason: retrieval.diagnostics.agent.directAnswerReason,
          evidenceCount: 0,
        },
        promptVersion: QA_PROMPT_VERSION,
        requestFinishedAt: Date.now(),
        requestKind: "answer-stream",
        requestStartedAt: answerStartedAt,
        status: "success",
        threadId: thread.id,
        usage: directUsage,
        userDocumentId: requestBody.activeDocumentId,
        userId: user.id,
      });

      writeSse(response, "verifier", {
        rejected: [],
        warnings: [],
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
        budget: computeAnswerContextBudget({ model: requestBody.model, mode: "answer" }),
        chatContext,
        evidence: retrieval.evidence,
        question: requestBody.question,
      }),
      model: requestBody.model,
      reasoningEffort: requestBody.reasoningEffort,
      onDelta: (text) => {
        answerText += text;
        writeSse(response, "delta", { text });
      },
      onThinking: (text) => {
        writeSse(response, "thinking", { text });
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

    console.log("[qa-stream] evidence lineRegions check:", retrieval.evidence.map((e) => ({
      evidenceId: e.evidenceId,
      hasLineRegions: Boolean(e.lineRegions),
      lineRegionsCount: e.lineRegions?.length ?? 0,
      pageStart: e.pageStart,
    })));
    console.log("[qa-stream] citation lineRegions check:", verification.citations.map((c) => ({
      evidenceId: c.evidenceId,
      hasLineRegions: Boolean(c.lineRegions),
      lineRegionsCount: c.lineRegions?.length ?? 0,
      pageStart: c.pageStart,
    })));

    const savedCitations = await insertQaCitations({
      citations: verification.citations,
      messageId: assistantMessage.id,
      userId: user.id,
    });

    console.log("[qa-stream] retrievalSnapshot evidence lineRegions check:",
      retrievalSnapshot.evidence.map((e) => ({
        evidenceId: e.evidenceId,
        hasLineRegions: Boolean(e.lineRegions),
      })));
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

async function handleDeleteThread(threadIdPathSegment, response, user) {
  const threadId = normalizeUuidLike(decodeURIComponent(threadIdPathSegment));

  if (!threadId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_thread_delete_request",
        message: "threadId is required.",
      },
    });
    return;
  }

  const result = await deleteQaThread({
    threadId,
    userId: user.id,
  });

  writeJson(response, 200, result);
}

async function handleDeleteMessage(messageIdPathSegment, response, user) {
  const messageId = normalizeUuidLike(decodeURIComponent(messageIdPathSegment));

  if (!messageId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_message_delete_request",
        message: "messageId is required.",
      },
    });
    return;
  }

  const result = await deleteQaMessage({
    messageId,
    userId: user.id,
  });

  writeJson(response, 200, result);
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
    reasoningEffort: normalizeReasoningEffort(body.reasoningEffort),
    regenerateMessageId: normalizeUuidLike(body.regenerateMessageId),
    scope: normalizeQaScope(body.scope),
    threadId,
  };
}

function normalizeAnswerLanguage(value) {
  return value === "zh" || value === "en" ? value : "auto";
}

function normalizeExecutionMode() {
  return "agentic";
}

function normalizeReasoningEffort(value) {
  return value === "quick" || value === "standard" || value === "deep" || value === "auto"
    ? value
    : "auto";
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

async function handleLongContextAnswer({
  abortController,
  agentSteps,
  answerLanguage,
  assistantMessageId,
  chatContext,
  model,
  question,
  questionType,
  reasoningEffort,
  response,
  threadId,
  userDocumentId,
  userId,
}) {
  const fullText = await loadCurrentPaperFullText({ userDocumentId, userId, model });
  const retrievalSnapshot = createRetrievalSnapshot({
    activeDocumentId: userDocumentId,
    evidence: [],
    queryPlan: { intent: "global", requiredEvidence: "none" },
    retrieverVersion: "long-context",
  });

  const planStep = {
    kind: "plan",
    messageId: assistantMessageId,
    payload: { longContext: true, questionType, truncated: fullText.truncated },
    status: "success",
    stepIndex: 0,
    summary: `识别为全局问题（${questionType.type}），使用长上下文全文阅读${fullText.truncated ? "（已截断）" : ""}。`,
  };
  const outlineStep = {
    kind: "answer_outline",
    messageId: assistantMessageId,
    payload: { longContext: true },
    status: "success",
    stepIndex: 1,
    summary: "将基于论文全文生成回答。",
  };
  agentSteps.push(planStep, outlineStep);

  writeSse(response, "agent_step", { step: planStep });
  writeSse(response, "agent_step", { step: outlineStep });
  writeSse(response, "retrieval", {
    diagnostics: { agent: { longContext: true, questionType }, candidateCount: 0 },
    snapshot: retrievalSnapshot,
    warnings: [],
  });

  let answerText = "";
  let usage;

  await streamQaChatCompletion({
    messages: buildQaAnswerMessages({
      answerLanguage,
      budget: computeAnswerContextBudget({ model, mode: "long_context" }),
      chatContext,
      evidence: [],
      fullPaperText: fullText.text,
      mode: "long_context",
      paperTitle: fullText.title,
      question,
    }),
    model,
    reasoningEffort,
    onDelta: (text) => {
      answerText += text;
      writeSse(response, "delta", { text });
    },
    onThinking: (text) => {
      writeSse(response, "thinking", { text });
    },
    onFinish: (finishReason) => {
      writeSse(response, "finish", { finishReason });
    },
    onUsage: (usageValue) => {
      usage = usageValue;
      writeSse(response, "usage", { usage: usageValue });
    },
    signal: abortController.signal,
  });

  const updatedMessage = await updateQaMessage({
    content: answerText,
    messageId: assistantMessageId,
    retrievalSnapshot,
    status: "success",
    userId,
  });
  await writeQaLogSilent({
    messageId: assistantMessageId,
    model,
    payload: {
      estimatedTokens: fullText.estimatedTokens,
      longContext: true,
      questionType: questionType.type,
      truncated: fullText.truncated,
    },
    promptVersion: QA_PROMPT_VERSION,
    requestFinishedAt: Date.now(),
    requestKind: "answer-stream",
    status: "success",
    threadId,
    usage,
    userDocumentId,
    userId,
  });

  writeSse(response, "verifier", { rejected: [], warnings: [] });
  writeSse(response, "done", {
    assistantMessage: { ...updatedMessage, agentSteps },
    citations: [],
    threadId,
  });
  response.end();
}

function buildQaChatContext({
  activeDocumentId,
  messages,
  question,
}) {
  const successfulMessages = (Array.isArray(messages) ? messages : [])
    .filter((message) =>
      (message.role === "user" || message.role === "assistant") &&
      message.status === "success" &&
      typeof message.content === "string" &&
      message.content.trim()
    );
  const recentMessages = successfulMessages
    .slice(-QA_CONTEXT_MAX_MESSAGES)
    .map((message) => ({
      content: truncateQaContextText(message.content, QA_CONTEXT_MAX_MESSAGE_CHARS),
      createdAt: message.createdAt,
      id: message.id,
      role: message.role,
    }));
  const carryoverEvidence = findLatestCarryoverEvidence({
    activeDocumentId,
    messages: successfulMessages,
  });
  const mentionedEvidenceIds = uniqueStrings([
    ...recentMessages.flatMap((message) => extractEvidenceIdsFromText(message.content)),
    ...carryoverEvidence.map((item) => item.evidenceId),
  ]);

  if (recentMessages.length === 0 && carryoverEvidence.length === 0) {
    return undefined;
  }

  return {
    carryoverEvidence,
    mentionedEvidenceIds,
    recentMessages,
    summary: [
      recentMessages.length > 0 ? `Loaded ${recentMessages.length} previous messages.` : "",
      carryoverEvidence.length > 0 ? `Loaded ${carryoverEvidence.length} prior evidence snippets.` : "",
    ].filter(Boolean).join(" "),
    userIntent: inferQaContextIntent(question, successfulMessages.length),
  };
}

function findLatestCarryoverEvidence({
  activeDocumentId,
  messages,
}) {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) =>
      message.role === "assistant" &&
      isRetrievalSnapshotForDocument(message.retrievalSnapshot, activeDocumentId) &&
      Array.isArray(message.retrievalSnapshot?.evidence) &&
      message.retrievalSnapshot.evidence.length > 0
    );

  if (!latestAssistantMessage) {
    return [];
  }

  const evidenceByChunkId = new Map();

  for (const item of latestAssistantMessage.retrievalSnapshot.evidence) {
    if (!item || typeof item.chunkId !== "string" || evidenceByChunkId.has(item.chunkId)) {
      continue;
    }

    evidenceByChunkId.set(item.chunkId, {
      chunkId: item.chunkId,
      cloudDocumentId: item.cloudDocumentId,
      documentTitle: item.documentTitle,
      evidenceId: item.evidenceId,
      lineRegions: item.lineRegions,
      pageEnd: item.pageEnd,
      pageStart: item.pageStart,
      pdfFingerprint: item.pdfFingerprint,
      score: item.score,
      scoreBreakdown: item.scoreBreakdown,
      sectionPath: item.sectionPath,
      textPreview: truncateQaContextText(item.textPreview ?? item.text ?? "", QA_CONTEXT_MAX_MESSAGE_CHARS),
    });

    if (evidenceByChunkId.size >= QA_CONTEXT_MAX_CARRYOVER_EVIDENCE) {
      break;
    }
  }

  return Array.from(evidenceByChunkId.values());
}

function isRetrievalSnapshotForDocument(snapshot, activeDocumentId) {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }

  return !snapshot.activeCloudDocumentId || snapshot.activeCloudDocumentId === activeDocumentId;
}

function inferQaContextIntent(question, previousMessageCount) {
  if (previousMessageCount === 0) {
    return "new_question";
  }

  const normalized = String(question ?? "").toLowerCase();

  if (
    /(它|这个|那个|上述|上面|前面|刚才|继续|展开|第二点|第三点|上一轮|前一轮)/.test(normalized) ||
    /\b(it|that|those|this|above|previous|earlier|continue|second|third)\b/.test(normalized)
  ) {
    return "follow_up";
  }

  return "contextual_question";
}

function extractEvidenceIdsFromText(text) {
  return Array.from(String(text ?? "").matchAll(/\[C(\d+)\]/g), (match) => `C${Number(match[1])}`);
}

function truncateQaContextText(value, maxCharacters) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trim()}...`;
}

function summarizeQaChatContextForLog(chatContext) {
  if (!chatContext) {
    return undefined;
  }

  return {
    carryoverEvidenceCount: chatContext.carryoverEvidence.length,
    mentionedEvidenceIds: chatContext.mentionedEvidenceIds,
    recentMessageCount: chatContext.recentMessages.length,
    userIntent: chatContext.userIntent,
  };
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

  if (error instanceof EmbeddingProviderError || error instanceof RerankerProviderError) {
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
  if (
    error instanceof SupabaseServiceError ||
    error instanceof QaChatModelError ||
    error instanceof EmbeddingProviderError ||
    error instanceof RerankerProviderError
  ) {
    return error.statusCode;
  }

  return 500;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}
