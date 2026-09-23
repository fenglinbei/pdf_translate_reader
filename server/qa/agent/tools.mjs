import { normalizeEvidenceIds } from "./evidence.mjs";

export const CURRENT_PAPER_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "search_current_paper", scope: "current", effect: "read", description: "Retrieve evidence within the authorized current paper." }),
  Object.freeze({ name: "open_chunk", scope: "current", effect: "read", description: "Expose full text of evidence already retrieved in this run." }),
]);

// Inputs contain tool arguments only. Identity and document scope come from the
// authenticated run, never from a model-supplied userId / userDocumentId field.
export function createCurrentPaperToolRegistry({ retrieveEvidence, events, signal, userDocumentId, userId }) {
  const handlers = new Map([
    ["search_current_paper", (input, context) => runSearchTool({
      matchCount: input.matchCount,
      query: input.query,
      retrievalCallIndex: input.retrievalCallIndex,
      state: context.state,
      retrieveEvidence,
      events,
      signal,
      userDocumentId,
      userId,
    })],
    ["open_chunk", (input, context) => runOpenChunkTool({
      action: { evidenceIds: input.evidenceIds },
      evidence: context.evidence,
      openedEvidenceIds: context.openedEvidenceIds,
      state: context.state,
      events,
      userId,
    })],
  ]);
  return Object.freeze({
    definitions: CURRENT_PAPER_TOOL_DEFINITIONS,
    async execute(name, input, context) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Unregistered current-paper tool: ${name}.`);
      return handler(input, context);
    },
  });
}

async function runSearchTool({
  events,
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
    const step = await events.recordStep(state, undefined, {
      evidenceIds,
      kind: "tool_call",
      payload: {
        query,
        retrievalCallIndex,
      },
      summary: `检索当前论文，召回 ${retrieval.evidence.length} 条候选证据。`,
      toolName: "search_current_paper",
    });
    await events.recordToolCall(state, step, {
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

    return retrieval;
  } catch (error) {
    const step = await events.recordStep(state, undefined, {
      kind: "tool_call",
      payload: {
        query,
        retrievalCallIndex,
      },
      status: "error",
      summary: "检索当前论文失败。",
      toolName: "search_current_paper",
    });
    await events.recordToolCall(state, step, {
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

    throw error;
  }
}

async function runOpenChunkTool({
  events,
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
  const step = await events.recordStep(state, undefined, {
    evidenceIds,
    kind: "tool_call",
    payload: {
      evidenceIds,
    },
    status,
    summary,
    toolName: "open_chunk",
  });
  await events.recordToolCall(state, step, {
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

  return opened;
}
