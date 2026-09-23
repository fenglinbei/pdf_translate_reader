import { QA_AGENT_RUNNER_VERSION } from "../config.mjs";
import { createQueryPlan } from "../queryPlan.mjs";
import { QaAgentRunnerError } from "./errors.mjs";
import { createAgentEvents } from "./events.mjs";
import { createCurrentPaperToolRegistry } from "./tools.mjs";
import { uniqueStrings, normalizePositiveInteger } from "./values.mjs";
import { normalizeControllerAction, normalizeControllerQuery } from "./controller.mjs";
import { normalizeCarryoverEvidence, mapCarryoverEvidenceToCurrentIds, summarizeChatContextForStep, summarizeChatContextForController } from "./context.mjs";
import { mergeEvidence, selectFinalEvidence, normalizeEvidenceIds, getTopPages, createEmptyRetrieval } from "./evidence.mjs";
import { createReasoningBudget, createReasoningPlanSummary, createControllerActionSummary, createObservationSummary } from "./policy.mjs";

// Owns loop state and stop conditions. Model, persistence and retrieval are ports.
export async function runReasoningAgenticRetrieval({
  callController,
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
  const events = createAgentEvents({ emit, insertStep, insertToolCall });
  const tools = createCurrentPaperToolRegistry({ retrieveEvidence, events, signal, userDocumentId, userId });
  const state = {
    agentSteps: [],
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
    await events.recordStep(state, "agent_step", {
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

      await events.recordStep(state, "gap_check", {
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
        const retrieval = await tools.execute("search_current_paper", {
          matchCount: Math.min(topK, budget.maxEvidence),
          query,
          retrievalCallIndex: retrievalCalls,
        }, { state });

        retrievals.push(retrieval);
        retrievalCalls += 1;
        evidence = mergeEvidence(evidence, retrieval.evidence, budget.maxEvidence);
        toolHistory.push({
          action: action.action,
          evidenceIds: evidence.map((item) => item.evidenceId),
          query,
          summary: `Search returned ${retrieval.evidence.length} candidates.`,
        });

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
        continue;
      }

      if (action.action === "open_chunk") {
        if (openCalls >= budget.maxOpenCalls) {
          warnings.push("Reasoning open-chunk budget was exhausted.");
          break;
        }

        const opened = await tools.execute("open_chunk", { evidenceIds: action.evidenceIds }, { evidence, openedEvidenceIds, state });

        openCalls += 1;
        toolHistory.push({
          action: action.action,
          evidenceIds: opened.map((item) => item.evidenceId),
          summary: `Opened ${opened.length} evidence chunks.`,
        });

        await events.recordStep(state, "observation", {
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
      await events.recordStep(state, "agent_step", {
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

    await events.recordStep(state, "agent_step", {
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
