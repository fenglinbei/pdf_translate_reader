import { QA_AGENT_RUNNER_VERSION } from "../config.mjs";
import { createQueryPlan } from "../queryPlan.mjs";
import { QaAgentRunnerError } from "./errors.mjs";
import { createAgentEvents } from "./events.mjs";
import { createCurrentPaperToolRegistry } from "./tools.mjs";
import { uniqueStrings, normalizePositiveInteger, getEnvInteger } from "./values.mjs";
import { mergeEvidence, getTopPages, createEmptyRetrieval } from "./evidence.mjs";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_RETRIEVAL_CALLS, DEFAULT_MAX_EVIDENCE, createPlanSummary, createObservationSummary, analyzeEvidenceGap, createFollowUpQuery } from "./policy.mjs";

// Compatibility path: the original rule-based loop remains available.
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
  const events = createAgentEvents({ emit, insertStep, insertToolCall });
  const tools = createCurrentPaperToolRegistry({ retrieveEvidence, events, signal, userDocumentId, userId });
  const state = {
    agentSteps: [],
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
    await events.recordStep(state, "agent_step", {
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
      const retrieval = await tools.execute("search_current_paper", {
        query,
        retrievalCallIndex: retrievalCalls,
      }, { state });

      retrievals.push(retrieval);
      retrievalCalls += 1;
      evidence = mergeEvidence(evidence, retrieval.evidence, maxEvidence);

      await events.recordStep(state, "observation", {
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

      await events.recordStep(state, "gap_check", {
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

    await events.recordStep(state, "agent_step", {
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
