import { QA_AGENT_RUNNER_VERSION } from "./config.mjs";
import {
  createQueryPlan,
  retrieveCurrentPaperEvidence,
} from "./retriever.mjs";
import {
  insertQaAgentStep,
  insertQaToolCall,
} from "../supabase/qa.mjs";

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_RETRIEVAL_CALLS = 2;
const DEFAULT_MAX_EVIDENCE = 12;
const LOW_SCORE_THRESHOLD = 0.12;

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

export async function recordAgentFallbackStep({
  emit,
  error,
  messageId,
  stepIndex = 0,
  userId,
}) {
  const step = await insertQaAgentStep({
    kind: "fallback",
    messageId,
    payload: {
      errorMessage: error instanceof Error ? error.message : "Agentic retrieval failed.",
      runnerVersion: QA_AGENT_RUNNER_VERSION,
    },
    status: "error",
    stepIndex,
    summary: "Agentic 检索失败，已自动退回单轮 RAG。",
    userId,
  });

  emit?.("agent_step", { step });

  return step;
}

async function runSearchTool({
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
