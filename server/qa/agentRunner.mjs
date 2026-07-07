import { QA_AGENT_RUNNER_VERSION } from "./config.mjs";
import {
  createQueryPlan,
  retrieveCurrentPaperEvidence,
} from "./retriever.mjs";
import {
  insertQaAgentStep,
  insertQaToolCall,
} from "../supabase/qa.mjs";
import { createQaChatCompletion } from "../chatModels/client.mjs";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RETRIEVAL_CALLS = 2;
const DEFAULT_MAX_EVIDENCE = 12;
const LOW_SCORE_THRESHOLD = 0.12;
const CONTROLLER_ACTIONS = new Set([
  "search_current_paper",
  "open_chunk",
  "finish_retrieval",
  "direct_answer",
]);
const REASONING_BUDGETS = {
  quick: {
    maxControllerCalls: 2,
    maxEvidence: 6,
    maxOpenCalls: 1,
    maxRetrievalCalls: 1,
    maxSteps: 7,
  },
  standard: {
    maxControllerCalls: 4,
    maxEvidence: 12,
    maxOpenCalls: 2,
    maxRetrievalCalls: 2,
    maxSteps: 12,
  },
  deep: {
    maxControllerCalls: 7,
    maxEvidence: 20,
    maxOpenCalls: 4,
    maxRetrievalCalls: 4,
    maxSteps: 18,
  },
};

export class QaAgentRunnerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "QaAgentRunnerError";
    this.agentSteps = options.agentSteps ?? [];
    this.cause = options.cause;
    this.nextStepIndex = options.nextStepIndex ?? 0;
  }
}

export async function runCurrentPaperAgenticRetrieval(input) {
  return runAgenticRetrieval({
    ...input,
    insertStep: insertQaAgentStep,
    insertToolCall: insertQaToolCall,
    retrieveEvidence: retrieveCurrentPaperEvidence,
  });
}

export async function runCurrentPaperReasoningRetrieval(input) {
  return runReasoningAgenticRetrieval({
    ...input,
    callController: input.callController ?? callReasoningController,
    insertStep: insertQaAgentStep,
    insertToolCall: insertQaToolCall,
    retrieveEvidence: retrieveCurrentPaperEvidence,
  });
}

export async function runReasoningAgenticRetrieval({
  callController = callReasoningController,
  chatContext,
  emit,
  insertStep,
  insertToolCall,
  messageId,
  model,
  question,
  reasoningEffort = "auto",
  retrieveEvidence,
  signal,
  userDocumentId,
  userId,
}) {
  const queryPlan = createQueryPlan(question);
  const budget = createReasoningBudget(reasoningEffort, queryPlan);
  const state = {
    agentSteps: [],
    emit,
    insertStep,
    insertToolCall,
    maxSteps: budget.maxSteps,
    messageId,
    nextStepIndex: 0,
    userId,
  };
  const openedEvidenceIds = new Set();
  const retrievals = [];
  const toolHistory = [];
  const warnings = [];
  const carryoverEvidence = normalizeCarryoverEvidence(chatContext?.carryoverEvidence, budget.maxEvidence);
  let evidence = carryoverEvidence;
  let finishAction;
  let directAnswer;
  let openCalls = 0;
  let retrievalCalls = 0;

  try {
    await recordStep(state, "agent_step", {
      kind: "plan",
      payload: {
        budget,
        chatContext: summarizeChatContextForStep(chatContext, carryoverEvidence),
        queryPlan,
        requestedReasoningEffort: reasoningEffort,
        runnerVersion: QA_AGENT_RUNNER_VERSION,
      },
      evidenceIds: carryoverEvidence.map((item) => item.evidenceId),
      summary: createReasoningPlanSummary({ budget, carryoverEvidence, chatContext }),
    });

    if (carryoverEvidence.length > 0) {
      toolHistory.push({
        action: "reuse_context_evidence",
        evidenceIds: carryoverEvidence.map((item) => item.evidenceId),
        summary: `Loaded ${carryoverEvidence.length} evidence snippets from the previous answer snapshot.`,
      });
    }

    for (let turnIndex = 0; turnIndex < budget.maxControllerCalls; turnIndex += 1) {
      const controllerResult = await callController({
        budget,
        chatContext: summarizeChatContextForController(
          chatContext,
          mapCarryoverEvidenceToCurrentIds(evidence, carryoverEvidence),
        ),
        evidence,
        model,
        openedEvidenceIds: Array.from(openedEvidenceIds),
        queryPlan,
        question,
        signal,
        toolHistory,
        turnIndex,
      });
      const action = normalizeControllerAction(controllerResult);

      if (action.action === "direct_answer") {
        directAnswer = action;
        break;
      }

      if (action.action === "finish_retrieval") {
        finishAction = action;
        break;
      }

      await recordStep(state, "gap_check", {
        evidenceIds: normalizeEvidenceIds(action.evidenceIds),
        kind: "gap_check",
        payload: {
          action,
          budget,
          turnIndex,
        },
        status: "success",
        summary: action.summary || createControllerActionSummary(action),
      });

      if (action.action === "search_current_paper") {
        if (retrievalCalls >= budget.maxRetrievalCalls) {
          warnings.push("Reasoning retrieval budget was exhausted before the model finished searching.");
          break;
        }

        const query = normalizeControllerQuery(action.query, question);
        const topK = normalizePositiveInteger(action.topK, budget.defaultTopK);
        const retrieval = await runSearchTool({
          matchCount: Math.min(topK, budget.maxEvidence),
          query,
          retrievalCallIndex: retrievalCalls,
          retrieveEvidence,
          signal,
          state,
          userDocumentId,
          userId,
        });

        retrievals.push(retrieval);
        retrievalCalls += 1;
        evidence = mergeEvidence(evidence, retrieval.evidence, budget.maxEvidence);
        toolHistory.push({
          action: action.action,
          evidenceIds: evidence.map((item) => item.evidenceId),
          query,
          summary: `Search returned ${retrieval.evidence.length} candidates.`,
        });

        await recordStep(state, "observation", {
          evidenceIds: evidence.map((item) => item.evidenceId),
          kind: "observation",
          payload: {
            candidateCount: retrieval.diagnostics?.candidateCount,
            embedding: retrieval.diagnostics?.embedding,
            rerank: retrieval.diagnostics?.rerank,
            retrievalCallIndex: retrievalCalls - 1,
            topPages: getTopPages(evidence),
          },
          summary: createObservationSummary(retrieval, evidence),
        });
        continue;
      }

      if (action.action === "open_chunk") {
        if (openCalls >= budget.maxOpenCalls) {
          warnings.push("Reasoning open-chunk budget was exhausted.");
          break;
        }

        const opened = await runOpenChunkTool({
          action,
          evidence,
          openedEvidenceIds,
          state,
          userId,
        });

        openCalls += 1;
        toolHistory.push({
          action: action.action,
          evidenceIds: opened.map((item) => item.evidenceId),
          summary: `Opened ${opened.length} evidence chunks.`,
        });

        await recordStep(state, "observation", {
          evidenceIds: opened.map((item) => item.evidenceId),
          kind: "observation",
          payload: {
            openedEvidenceIds: Array.from(openedEvidenceIds),
          },
          summary: opened.length > 0
            ? `已打开 ${opened.map((item) => item.evidenceId).join(", ")} 的完整证据文本。`
            : "没有可打开的证据块。",
        });
      }
    }

    if (directAnswer) {
      await recordStep(state, "agent_step", {
        evidenceIds: [],
        kind: "answer_outline",
        payload: {
          directAnswer: true,
          reason: directAnswer.reason,
          replyOutline: directAnswer.replyOutline,
        },
        summary: directAnswer.summary ||
          directAnswer.replyOutline ||
          "跳过检索，将直接回答（非论文内容问题）。",
      });

      const emptyRetrieval = createEmptyRetrieval(queryPlan);

      return {
        ...emptyRetrieval,
        agentSteps: state.agentSteps,
        diagnostics: {
          ...emptyRetrieval.diagnostics,
          agent: {
            controller: "llm-json-v1",
            directAnswer: true,
            directAnswerReason: directAnswer.reason ?? "general_knowledge",
            mode: "agentic",
            requestedReasoningEffort: reasoningEffort,
            runnerVersion: QA_AGENT_RUNNER_VERSION,
            stepCount: state.agentSteps.length,
          },
        },
        evidence: [],
        queryPlan: { ...queryPlan, intent: "direct_answer" },
        warnings: [],
      };
    }

    const selectedEvidence = selectFinalEvidence(evidence, finishAction?.evidenceIds);

    await recordStep(state, "agent_step", {
      evidenceIds: selectedEvidence.map((item) => item.evidenceId),
      kind: "answer_outline",
      payload: {
        answerOutline: finishAction?.answerOutline,
        evidenceCount: selectedEvidence.length,
      },
      summary: finishAction?.answerOutline ||
        (selectedEvidence.length > 0
          ? `将基于 ${selectedEvidence.map((item) => item.evidenceId).join(", ")} 生成回答。`
          : "没有找到可引用证据，将说明证据不足。"),
    });

    const finalRetrieval = retrievals[retrievals.length - 1] ?? createEmptyRetrieval(queryPlan);

    return {
      ...finalRetrieval,
      agentSteps: state.agentSteps,
      diagnostics: {
        ...finalRetrieval.diagnostics,
        agent: {
          chatContext: summarizeChatContextForStep(
            chatContext,
            mapCarryoverEvidenceToCurrentIds(evidence, carryoverEvidence),
          ),
          controller: "llm-json-v1",
          effectiveReasoningEffort: budget.effectiveEffort,
          mode: "agentic",
          requestedReasoningEffort: reasoningEffort,
          retrievalCalls,
          runnerVersion: QA_AGENT_RUNNER_VERSION,
          stepCount: state.agentSteps.length,
        },
      },
      evidence: selectedEvidence,
      queryPlan,
      warnings: uniqueStrings([
        ...(finalRetrieval.warnings ?? []),
        ...warnings,
      ]),
    };
  } catch (error) {
    if (error instanceof QaAgentRunnerError) {
      throw error;
    }

    throw new QaAgentRunnerError(
      error instanceof Error ? error.message : "Reasoning controller failed.",
      {
        agentSteps: state.agentSteps,
        cause: error,
        nextStepIndex: state.nextStepIndex,
      },
    );
  }
}

export async function runAgenticRetrieval({
  emit,
  insertStep,
  insertToolCall,
  messageId,
  question,
  retrieveEvidence,
  signal,
  userDocumentId,
  userId,
  limits = {},
}) {
  const maxSteps = normalizePositiveInteger(limits.maxSteps, getEnvInteger("QA_AGENT_MAX_STEPS", DEFAULT_MAX_STEPS));
  const maxRetrievalCalls = normalizePositiveInteger(
    limits.maxRetrievalCalls,
    getEnvInteger("QA_AGENT_MAX_RETRIEVAL_CALLS", DEFAULT_MAX_RETRIEVAL_CALLS),
  );
  const maxEvidence = normalizePositiveInteger(
    limits.maxEvidence,
    getEnvInteger("QA_AGENT_MAX_EVIDENCE", DEFAULT_MAX_EVIDENCE),
  );
  const state = {
    agentSteps: [],
    emit,
    insertStep,
    insertToolCall,
    maxSteps,
    messageId,
    nextStepIndex: 0,
    userId,
  };
  const queryPlan = createQueryPlan(question);
  const retrievals = [];
  const warnings = [];
  let evidence = [];
  let retrievalCalls = 0;

  try {
    await recordStep(state, "agent_step", {
      kind: "plan",
      payload: {
        queryPlan,
        runnerVersion: QA_AGENT_RUNNER_VERSION,
      },
      summary: createPlanSummary(queryPlan),
    });

    while (retrievalCalls < maxRetrievalCalls) {
      const query = retrievalCalls === 0
        ? question
        : createFollowUpQuery(question, queryPlan);
      const previousEvidenceCount = evidence.length;
      const retrieval = await runSearchTool({
        query,
        retrievalCallIndex: retrievalCalls,
        retrieveEvidence,
        signal,
        state,
        userDocumentId,
        userId,
      });

      retrievals.push(retrieval);
      retrievalCalls += 1;
      evidence = mergeEvidence(evidence, retrieval.evidence, maxEvidence);

      await recordStep(state, "observation", {
        evidenceIds: evidence.map((item) => item.evidenceId),
        kind: "observation",
        payload: {
          candidateCount: retrieval.diagnostics?.candidateCount,
          embedding: retrieval.diagnostics?.embedding,
          rerank: retrieval.diagnostics?.rerank,
          retrievalCallIndex: retrievalCalls - 1,
          topPages: getTopPages(evidence),
        },
        summary: createObservationSummary(retrieval, evidence),
      });

      const gap = analyzeEvidenceGap({
        evidence,
        maxRetrievalCalls,
        newEvidenceCount: evidence.length - previousEvidenceCount,
        queryPlan,
        retrievalCalls,
      });

      if (gap.warning) {
        warnings.push(gap.warning);
      }

      await recordStep(state, "gap_check", {
        evidenceIds: evidence.map((item) => item.evidenceId),
        kind: "gap_check",
        payload: {
          needsFollowUp: gap.needsFollowUp,
          reason: gap.reason,
          retrievalCalls,
        },
        status: gap.needsFollowUp ? "skipped" : "success",
        summary: gap.summary,
      });

      if (!gap.needsFollowUp || retrievalCalls >= maxRetrievalCalls) {
        break;
      }
    }

    await recordStep(state, "agent_step", {
      evidenceIds: evidence.map((item) => item.evidenceId),
      kind: "answer_outline",
      payload: {
        evidenceCount: evidence.length,
      },
      summary: evidence.length > 0
        ? `将基于 ${evidence.map((item) => item.evidenceId).join(", ")} 生成回答。`
        : "没有找到可引用证据，将说明证据不足。",
    });

    const finalRetrieval = retrievals[retrievals.length - 1] ?? createEmptyRetrieval(queryPlan);

    return {
      ...finalRetrieval,
      agentSteps: state.agentSteps,
      diagnostics: {
        ...finalRetrieval.diagnostics,
        agent: {
          mode: "agentic",
          retrievalCalls,
          runnerVersion: QA_AGENT_RUNNER_VERSION,
          stepCount: state.agentSteps.length,
        },
      },
      evidence,
      queryPlan,
      warnings: uniqueStrings([
        ...(finalRetrieval.warnings ?? []),
        ...warnings,
      ]),
    };
  } catch (error) {
    if (error instanceof QaAgentRunnerError) {
      throw error;
    }

    throw new QaAgentRunnerError(
      error instanceof Error ? error.message : "Agentic retrieval failed.",
      {
        agentSteps: state.agentSteps,
        cause: error,
        nextStepIndex: state.nextStepIndex,
      },
    );
  }
}

async function runSearchTool({
  matchCount,
  query,
  retrievalCallIndex,
  retrieveEvidence,
  signal,
  state,
  userDocumentId,
  userId,
}) {
  const startedAt = Date.now();

  try {
    const retrieval = await retrieveEvidence({
      matchCount,
      question: query,
      signal,
      userDocumentId,
      userId,
    });
    const evidenceIds = retrieval.evidence.map((item) => item.evidenceId);
    const step = await recordStep(state, undefined, {
      evidenceIds,
      kind: "tool_call",
      payload: {
        query,
        retrievalCallIndex,
      },
      summary: `检索当前论文，召回 ${retrieval.evidence.length} 条候选证据。`,
      toolName: "search_current_paper",
    });
    const toolCall = await state.insertToolCall({
      finishedAt: Date.now(),
      input: {
        matchCount,
        query,
        scope: "current",
      },
      outputSummary: `召回 ${retrieval.evidence.length} 条候选证据。`,
      resultEvidenceIds: evidenceIds,
      startedAt,
      status: "success",
      stepId: step.id,
      toolName: "search_current_paper",
      userId,
    });
    const stepWithToolCall = {
      ...step,
      toolCall,
    };

    state.agentSteps = state.agentSteps.map((item) =>
      item.id === step.id ? stepWithToolCall : item
    );
    state.emit?.("tool_call", {
      step: stepWithToolCall,
      toolCall,
    });

    return retrieval;
  } catch (error) {
    const step = await recordStep(state, undefined, {
      kind: "tool_call",
      payload: {
        query,
        retrievalCallIndex,
      },
      status: "error",
      summary: "检索当前论文失败。",
      toolName: "search_current_paper",
    });
    const toolCall = await state.insertToolCall({
      errorMessage: error instanceof Error ? error.message : "Current-paper search failed.",
      finishedAt: Date.now(),
      input: {
        matchCount,
        query,
        scope: "current",
      },
      outputSummary: "检索当前论文失败。",
      resultEvidenceIds: [],
      startedAt,
      status: "error",
      stepId: step.id,
      toolName: "search_current_paper",
      userId,
    });
    const stepWithToolCall = {
      ...step,
      toolCall,
    };

    state.agentSteps = state.agentSteps.map((item) =>
      item.id === step.id ? stepWithToolCall : item
    );
    state.emit?.("tool_call", {
      step: stepWithToolCall,
      toolCall,
    });

    throw error;
  }
}

async function recordStep(state, eventName, input) {
  if (state.nextStepIndex >= state.maxSteps) {
    return {
      createdAt: Date.now(),
      evidenceIds: input.evidenceIds ?? [],
      id: `skipped-step-${state.nextStepIndex}`,
      kind: input.kind,
      messageId: state.messageId,
      payload: input.payload,
      status: "skipped",
      stepIndex: state.nextStepIndex,
      summary: input.summary,
      toolName: input.toolName,
    };
  }

  const step = await state.insertStep({
    evidenceIds: input.evidenceIds ?? [],
    kind: input.kind,
    messageId: state.messageId,
    payload: input.payload,
    status: input.status ?? "success",
    stepIndex: state.nextStepIndex,
    summary: input.summary,
    toolName: input.toolName,
    userId: state.userId,
  });

  state.nextStepIndex += 1;
  state.agentSteps.push(step);
  if (eventName) {
    state.emit?.(eventName, { step });
  }

  return step;
}

async function runOpenChunkTool({
  action,
  evidence,
  openedEvidenceIds,
  state,
  userId,
}) {
  const startedAt = Date.now();
  const evidenceIds = normalizeEvidenceIds(action.evidenceIds);
  const opened = evidence.filter((item) => evidenceIds.includes(item.evidenceId));

  for (const item of opened) {
    openedEvidenceIds.add(item.evidenceId);
  }

  const status = opened.length > 0 ? "success" : "skipped";
  const summary = opened.length > 0
    ? `打开 ${opened.map((item) => item.evidenceId).join(", ")} 的完整证据文本。`
    : "没有找到可打开的证据块。";
  const step = await recordStep(state, undefined, {
    evidenceIds,
    kind: "tool_call",
    payload: {
      evidenceIds,
    },
    status,
    summary,
    toolName: "open_chunk",
  });
  const toolCall = await state.insertToolCall({
    finishedAt: Date.now(),
    input: {
      evidenceIds,
      scope: "current",
    },
    outputSummary: summary,
    resultEvidenceIds: opened.map((item) => item.evidenceId),
    startedAt,
    status,
    stepId: step.id,
    toolName: "open_chunk",
    userId,
  });
  const stepWithToolCall = {
    ...step,
    toolCall,
  };

  state.agentSteps = state.agentSteps.map((item) =>
    item.id === step.id ? stepWithToolCall : item
  );
  state.emit?.("tool_call", {
    step: stepWithToolCall,
    toolCall,
  });

  return opened;
}

async function callReasoningController({
  budget,
  chatContext,
  evidence,
  model,
  openedEvidenceIds,
  queryPlan,
  question,
  signal,
  toolHistory,
  turnIndex,
}) {
  const result = await createQaChatCompletion({
    messages: buildReasoningControllerMessages({
      budget,
      chatContext,
      evidence,
      openedEvidenceIds,
      queryPlan,
      question,
      toolHistory,
      turnIndex,
    }),
    model,
    signal,
    temperature: 0.1,
  });

  return parseControllerJson(result.content);
}

function buildReasoningControllerMessages({
  budget,
  chatContext,
  evidence,
  openedEvidenceIds,
  queryPlan,
  question,
  toolHistory,
  turnIndex,
}) {
  return [
    {
      role: "system",
      content: [
        "You are a retrieval controller for current-paper QA.",
        "Return only one JSON object. Do not wrap it in Markdown.",
        "Do not reveal chain-of-thought. Put only a concise user-visible rationale in summary.",
        "Decide whether the user's message actually needs evidence from the paper before searching.",
        "Use direct_answer (not search_current_paper) when the message does NOT require paper content, such as:",
        "- greetings, thanks, or social replies (hi, hello, thanks, 嗨, 你好, 谢谢)",
        "- questions about your identity or capabilities (who are you, what can you do)",
        "- meta questions about the conversation (can you explain your previous answer)",
        "- general-knowledge questions unrelated to the paper's specific content",
        "Anything that depends on THIS paper's content (methods, results, figures, claims) MUST use search_current_paper.",
        "Allowed actions:",
        '{"action":"search_current_paper","summary":"...","query":"...","topK":8}',
        '{"action":"open_chunk","summary":"...","evidenceIds":["C1"]}',
        '{"action":"finish_retrieval","summary":"...","evidenceIds":["C1","C2"],"answerOutline":"..."}',
        '{"action":"direct_answer","summary":"...","reason":"greeting|chitchat|meta|general_knowledge","replyOutline":"brief reply outline"}',
        "All retrieval must stay inside the current paper.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        budget: {
          effort: budget.effectiveEffort,
          maxEvidence: budget.maxEvidence,
          maxOpenCalls: budget.maxOpenCalls,
          maxRetrievalCalls: budget.maxRetrievalCalls,
        },
        currentEvidence: evidence.map((item) => ({
          evidenceId: item.evidenceId,
          opened: openedEvidenceIds.includes(item.evidenceId),
          page: item.pageStart,
          preview: openedEvidenceIds.includes(item.evidenceId)
            ? truncateForController(item.text ?? item.textPreview, 1600)
            : truncateForController(item.textPreview, 360),
          score: item.score,
          sectionPath: item.sectionPath,
        })),
        conversationContext: chatContext,
        queryPlan,
        question,
        toolHistory: toolHistory.slice(-6),
        turnIndex,
      }),
    },
  ];
}

function normalizeCarryoverEvidence(values, maxEvidence) {
  const evidenceByChunkId = new Map();

  for (const item of Array.isArray(values) ? values : []) {
    if (!item || typeof item.chunkId !== "string" || evidenceByChunkId.has(item.chunkId)) {
      continue;
    }

    evidenceByChunkId.set(item.chunkId, {
      chunkId: item.chunkId,
      cloudDocumentId: item.cloudDocumentId,
      documentTitle: item.documentTitle,
      evidenceId: item.evidenceId,
      mmd: item.mmd,
      pageEnd: item.pageEnd,
      pageStart: item.pageStart,
      pdfFingerprint: item.pdfFingerprint,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      scoreBreakdown: item.scoreBreakdown,
      sectionPath: Array.isArray(item.sectionPath) ? item.sectionPath : [],
      text: item.text,
      textPreview: item.textPreview ?? item.text ?? "",
    });
  }

  return Array.from(evidenceByChunkId.values())
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, maxEvidence)
    .map((item, index) => ({
      ...item,
      evidenceId: `C${index + 1}`,
    }));
}

function mapCarryoverEvidenceToCurrentIds(currentEvidence, carryoverEvidence) {
  if (!Array.isArray(currentEvidence) || !Array.isArray(carryoverEvidence) || carryoverEvidence.length === 0) {
    return [];
  }

  const carryoverChunkIds = new Set(carryoverEvidence.map((item) => item.chunkId));

  return currentEvidence.filter((item) => carryoverChunkIds.has(item.chunkId));
}

function createReasoningPlanSummary({
  budget,
  carryoverEvidence,
  chatContext,
}) {
  const contextCount = chatContext?.recentMessages?.length ?? 0;

  if (contextCount > 0 || carryoverEvidence.length > 0) {
    return `已加载最近 ${contextCount} 条对话，并带入 ${carryoverEvidence.length} 条上轮证据；模型将以 ${budget.effectiveEffort} 强度自主决定是否继续检索。`;
  }

  return `模型将以 ${budget.effectiveEffort} 强度自主规划当前论文检索。`;
}

function summarizeChatContextForStep(chatContext, carryoverEvidence) {
  if (!chatContext) {
    return undefined;
  }

  return {
    carryoverEvidenceIds: carryoverEvidence.map((item) => item.evidenceId),
    mentionedEvidenceIds: chatContext.mentionedEvidenceIds ?? [],
    recentMessageCount: chatContext.recentMessages?.length ?? 0,
    summary: chatContext.summary,
    userIntent: chatContext.userIntent,
  };
}

function summarizeChatContextForController(chatContext, carryoverEvidence) {
  if (!chatContext) {
    return undefined;
  }

  return {
    carryoverEvidenceIds: carryoverEvidence.map((item) => item.evidenceId),
    instruction: [
      "Use the recent messages only to resolve follow-up references and decide whether prior evidence is still relevant.",
      "Paper facts must be supported by currentEvidence and final citations must use current evidence ids only.",
    ].join(" "),
    mentionedEvidenceIds: chatContext.mentionedEvidenceIds ?? [],
    recentMessages: (chatContext.recentMessages ?? []).map((message) => ({
      content: truncateForController(stripPriorCitationIds(message.content), 700),
      role: message.role,
    })),
    userIntent: chatContext.userIntent,
  };
}

function stripPriorCitationIds(text) {
  return String(text ?? "").replace(/\[C\d+\]/g, "[prior citation]");
}

function parseControllerJson(content) {
  const text = String(content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
  }

  throw new Error("Reasoning controller returned invalid JSON.");
}

function normalizeControllerAction(action) {
  if (!action || typeof action !== "object") {
    throw new Error("Reasoning controller action must be an object.");
  }

  const actionName = typeof action.action === "string" ? action.action : "";

  if (!CONTROLLER_ACTIONS.has(actionName)) {
    throw new Error(`Reasoning controller returned unsupported action: ${actionName || "missing"}.`);
  }

  return {
    action: actionName,
    answerOutline: typeof action.answerOutline === "string" ? action.answerOutline.trim() : undefined,
    evidenceIds: normalizeEvidenceIds(action.evidenceIds),
    query: typeof action.query === "string" ? action.query.trim() : undefined,
    reason: typeof action.reason === "string" ? action.reason.trim() : undefined,
    replyOutline: typeof action.replyOutline === "string" ? action.replyOutline.trim() : undefined,
    summary: typeof action.summary === "string" ? action.summary.trim() : undefined,
    topK: normalizePositiveInteger(action.topK, undefined),
  };
}

function createControllerActionSummary(action) {
  if (action.action === "search_current_paper") {
    return `模型决定检索当前论文：${action.query || "使用原问题"}`;
  }

  if (action.action === "open_chunk") {
    return `模型决定打开证据：${normalizeEvidenceIds(action.evidenceIds).join(", ") || "-"}`;
  }

  return "模型认为当前证据足以生成回答。";
}

function createReasoningBudget(reasoningEffort, queryPlan) {
  const requestedEffort = normalizeReasoningEffort(reasoningEffort);
  const effectiveEffort = requestedEffort === "auto"
    ? inferReasoningEffort(queryPlan)
    : requestedEffort;
  const budget = REASONING_BUDGETS[effectiveEffort] ?? REASONING_BUDGETS.standard;

  return {
    ...budget,
    defaultTopK: Math.min(budget.maxEvidence, effectiveEffort === "quick" ? 6 : 10),
    effectiveEffort,
    requestedEffort,
  };
}

function normalizeReasoningEffort(value) {
  return value === "quick" || value === "standard" || value === "deep" || value === "auto"
    ? value
    : "auto";
}

function inferReasoningEffort(queryPlan) {
  if (queryPlan.requiredEvidence === "comparison" || queryPlan.intent === "summary") {
    return "deep";
  }

  if (queryPlan.requiredEvidence === "multi" || queryPlan.intent === "result") {
    return "standard";
  }

  return "quick";
}

function normalizeControllerQuery(query, fallback) {
  const normalized = String(query ?? "").replace(/\s+/g, " ").trim();

  return normalized || fallback;
}

function normalizeEvidenceIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueStrings(values.map((value) => String(value ?? "").trim()));
}

function selectFinalEvidence(evidence, evidenceIds) {
  const selectedIds = normalizeEvidenceIds(evidenceIds);

  if (selectedIds.length === 0) {
    return evidence;
  }

  const selectedEvidence = selectedIds
    .map((evidenceId) => evidence.find((item) => item.evidenceId === evidenceId))
    .filter(Boolean);

  return selectedEvidence.length > 0 ? selectedEvidence : evidence;
}

function truncateForController(value, maxCharacters) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, maxCharacters - 3).trim()}...`;
}

function createPlanSummary(queryPlan) {
  const intentLabels = {
    comparison: "对比",
    method: "方法",
    question: "普通问答",
    result: "结果",
    summary: "总结",
  };

  return `识别为${intentLabels[queryPlan.intent] ?? queryPlan.intent}问题，需要 ${queryPlan.requiredEvidence} 类证据。`;
}

function createObservationSummary(retrieval, evidence) {
  const candidateCount = retrieval.diagnostics?.candidateCount ?? retrieval.evidence.length;
  const topPages = getTopPages(evidence);
  const pageSummary = topPages.length > 0 ? `，主要页码：${topPages.join(", ")}` : "";
  const embeddingSummary = retrieval.diagnostics?.embedding?.used ? "使用了语义检索" : "使用文本检索";
  const rerankSummary = retrieval.diagnostics?.rerank?.model ? `，并由 ${retrieval.diagnostics.rerank.model} 重排` : "";

  return `${embeddingSummary}${rerankSummary}，得到 ${candidateCount} 条候选${pageSummary}。`;
}

function analyzeEvidenceGap({
  evidence,
  maxRetrievalCalls,
  newEvidenceCount,
  queryPlan,
  retrievalCalls,
}) {
  const canFollowUp = retrievalCalls < maxRetrievalCalls;

  if (evidence.length === 0) {
    return {
      needsFollowUp: canFollowUp,
      reason: "no_evidence",
      summary: canFollowUp
        ? "没有找到可支持回答的证据，需要换一种检索表达。"
        : "仍未找到可支持回答的证据，停止继续检索。",
      warning: "No current-paper evidence was found for this question.",
    };
  }

  if (newEvidenceCount <= 0 && retrievalCalls > 1) {
    return {
      needsFollowUp: false,
      reason: "no_new_evidence",
      summary: "追加检索没有带来新的证据，停止继续检索。",
      warning: "Follow-up retrieval did not add new evidence.",
    };
  }

  if (queryPlan.requiredEvidence !== "single" && evidence.length < 3) {
    return {
      needsFollowUp: canFollowUp,
      reason: "multi_evidence_weak",
      summary: canFollowUp
        ? "该问题最好需要多条证据，目前证据偏少，将尝试补充检索。"
        : "该问题最好需要多条证据，但已达到检索上限，将基于现有证据回答。",
      warning: "Evidence is weak for a multi-evidence question.",
    };
  }

  if (evidence.length > 1 && new Set(evidence.map((item) => item.pageStart)).size === 1) {
    return {
      needsFollowUp: canFollowUp,
      reason: "single_page_evidence",
      summary: canFollowUp
        ? "证据集中在同一页，将尝试补充其他页的证据。"
        : "证据仍集中在同一页，但已达到检索上限，将基于现有证据回答。",
      warning: "Retrieved evidence is concentrated on one page.",
    };
  }

  if (evidence.every((item) => Number(item.score) < LOW_SCORE_THRESHOLD)) {
    return {
      needsFollowUp: canFollowUp,
      reason: "low_score",
      summary: canFollowUp
        ? "召回分数整体偏低，将尝试补充检索。"
        : "召回分数仍整体偏低，但已达到检索上限，将基于现有证据回答。",
      warning: "Retrieved evidence scores are low.",
    };
  }

  return {
    needsFollowUp: false,
    reason: "sufficient",
    summary: "当前证据足以进入回答生成。",
  };
}

function createFollowUpQuery(question, queryPlan) {
  if (queryPlan.intent === "summary") {
    return `${question} abstract introduction method results conclusion limitations`;
  }

  if (queryPlan.intent === "comparison") {
    return `${question} method results experiments limitations comparison`;
  }

  if (queryPlan.intent === "result") {
    return `${question} experiments evaluation results metrics`;
  }

  if (queryPlan.intent === "method") {
    return `${question} method approach algorithm objective training`;
  }

  return `${question} evidence method results limitations`;
}

function mergeEvidence(currentEvidence, nextEvidence, maxEvidence) {
  const evidenceByChunkId = new Map();

  for (const item of [...currentEvidence, ...nextEvidence]) {
    const existing = evidenceByChunkId.get(item.chunkId);

    if (!existing || Number(item.score) > Number(existing.score)) {
      evidenceByChunkId.set(item.chunkId, item);
    }
  }

  return Array.from(evidenceByChunkId.values())
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, maxEvidence)
    .map((item, index) => ({
      ...item,
      evidenceId: `C${index + 1}`,
    }));
}

function getTopPages(evidence) {
  return Array.from(new Set(
    evidence
      .slice(0, 5)
      .map((item) => `p.${item.pageStart}`)
      .filter(Boolean),
  ));
}

function createEmptyRetrieval(queryPlan) {
  return {
    diagnostics: {
      agent: {
        runnerVersion: QA_AGENT_RUNNER_VERSION,
      },
      candidateCount: 0,
    },
    evidence: [],
    queryPlan,
    retrieverVersion: "none",
    warnings: [],
  };
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function getEnvInteger(name, fallback) {
  return normalizePositiveInteger(process.env[name], fallback);
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
