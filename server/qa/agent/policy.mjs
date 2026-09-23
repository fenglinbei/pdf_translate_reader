import { getTopPages, normalizeEvidenceIds } from "./evidence.mjs";

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_RETRIEVAL_CALLS = 2;
export const DEFAULT_MAX_EVIDENCE = 12;
const LOW_SCORE_THRESHOLD = 0.12;
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

export function createReasoningPlanSummary({
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

export function createControllerActionSummary(action) {
  if (action.action === "search_current_paper") {
    return `模型决定检索当前论文：${action.query || "使用原问题"}`;
  }

  if (action.action === "open_chunk") {
    return `模型决定打开证据：${normalizeEvidenceIds(action.evidenceIds).join(", ") || "-"}`;
  }

  return "模型认为当前证据足以生成回答。";
}

export function createReasoningBudget(reasoningEffort, queryPlan) {
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

export function createPlanSummary(queryPlan) {
  const intentLabels = {
    comparison: "对比",
    method: "方法",
    question: "普通问答",
    result: "结果",
    summary: "总结",
  };

  return `识别为${intentLabels[queryPlan.intent] ?? queryPlan.intent}问题，需要 ${queryPlan.requiredEvidence} 类证据。`;
}

export function createObservationSummary(retrieval, evidence) {
  const candidateCount = retrieval.diagnostics?.candidateCount ?? retrieval.evidence.length;
  const topPages = getTopPages(evidence);
  const pageSummary = topPages.length > 0 ? `，主要页码：${topPages.join(", ")}` : "";
  const embeddingSummary = retrieval.diagnostics?.embedding?.used ? "使用了语义检索" : "使用文本检索";
  const rerankSummary = retrieval.diagnostics?.rerank?.model ? `，并由 ${retrieval.diagnostics.rerank.model} 重排` : "";

  return `${embeddingSummary}${rerankSummary}，得到 ${candidateCount} 条候选${pageSummary}。`;
}

export function analyzeEvidenceGap({
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

export function createFollowUpQuery(question, queryPlan) {
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
