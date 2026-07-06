import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QaAgentRunnerError,
  runAgenticRetrieval,
} from "../../server/qa/agentRunner.mjs";
import { createQueryPlan } from "../../server/qa/retriever.mjs";

describe("runAgenticRetrieval", () => {
  it("records plan, search, observation, gap, and outline steps for current-paper evidence", async () => {
    const store = createAgentStore();
    const events = [];
    const retrievalCalls = [];

    const result = await runAgenticRetrieval({
      emit: (eventName, payload) => events.push({ eventName, payload }),
      insertStep: store.insertStep,
      insertToolCall: store.insertToolCall,
      messageId: "message-1",
      question: "Summarize the method and results",
      retrieveEvidence: async ({ question }) => {
        retrievalCalls.push(question);

        return createRetrieval([
          makeEvidence("chunk-1", 1, 0.88),
          makeEvidence("chunk-2", 2, 0.76),
          makeEvidence("chunk-3", 4, 0.64),
        ], question);
      },
      userDocumentId: "doc-1",
      userId: "user-1",
    });

    assert.equal(retrievalCalls.length, 1);
    assert.deepEqual(result.agentSteps.map((step) => step.kind), [
      "plan",
      "tool_call",
      "observation",
      "gap_check",
      "answer_outline",
    ]);
    assert.deepEqual(events.map((event) => event.eventName), [
      "agent_step",
      "tool_call",
      "observation",
      "gap_check",
      "agent_step",
    ]);
    assert.equal(result.evidence.length, 3);
    assert.equal(result.diagnostics.agent.mode, "agentic");
    assert.equal(result.diagnostics.agent.retrievalCalls, 1);
    assert.equal(store.toolCalls.length, 1);
    assert.equal(result.agentSteps[1].toolCall.toolName, "search_current_paper");
  });

  it("runs one follow-up retrieval and stops when no evidence is found", async () => {
    const store = createAgentStore();
    const retrievalCalls = [];

    const result = await runAgenticRetrieval({
      emit: () => undefined,
      insertStep: store.insertStep,
      insertToolCall: store.insertToolCall,
      limits: {
        maxRetrievalCalls: 2,
        maxSteps: 8,
      },
      messageId: "message-2",
      question: "Summarize the paper",
      retrieveEvidence: async ({ question }) => {
        retrievalCalls.push(question);

        return createRetrieval([], question);
      },
      userDocumentId: "doc-1",
      userId: "user-1",
    });

    assert.equal(retrievalCalls.length, 2);
    assert.equal(result.evidence.length, 0);
    assert.equal(result.agentSteps.length, 8);
    assert.equal(result.agentSteps.at(-1).kind, "answer_outline");
    assert.match(result.agentSteps.at(-1).summary, /没有找到可引用证据/);
    assert.match(result.warnings.join("\n"), /No current-paper evidence/);
    assert.equal(store.toolCalls.length, 2);
  });

  it("throws a runner error with persisted failed steps when current-paper search fails", async () => {
    const store = createAgentStore();

    await assert.rejects(
      () => runAgenticRetrieval({
        emit: () => undefined,
        insertStep: store.insertStep,
        insertToolCall: store.insertToolCall,
        messageId: "message-3",
        question: "What failed?",
        retrieveEvidence: async () => {
          throw new Error("retriever unavailable");
        },
        userDocumentId: "doc-1",
        userId: "user-1",
      }),
      (error) => {
        assert.ok(error instanceof QaAgentRunnerError);
        assert.equal(error.message, "retriever unavailable");
        assert.equal(error.nextStepIndex, 2);
        assert.deepEqual(error.agentSteps.map((step) => step.kind), ["plan", "tool_call"]);
        assert.equal(error.agentSteps[1].status, "error");
        assert.equal(error.agentSteps[1].toolCall.errorMessage, "retriever unavailable");

        return true;
      },
    );
    assert.equal(store.toolCalls.length, 1);
  });
});

function createAgentStore() {
  const steps = [];
  const toolCalls = [];

  return {
    insertStep: async (input) => {
      const step = {
        createdAt: Date.parse("2026-01-01T00:00:00.000Z") + input.stepIndex,
        deletedAt: undefined,
        evidenceIds: input.evidenceIds ?? [],
        id: `step-${input.stepIndex}`,
        kind: input.kind,
        messageId: input.messageId,
        payload: input.payload,
        status: input.status ?? "success",
        stepIndex: input.stepIndex,
        summary: input.summary,
        toolName: input.toolName,
      };

      steps.push(step);

      return step;
    },
    insertToolCall: async (input) => {
      const toolCall = {
        createdAt: Date.parse("2026-01-01T00:00:00.000Z") + toolCalls.length,
        deletedAt: undefined,
        errorMessage: input.errorMessage,
        finishedAt: input.finishedAt,
        id: `tool-call-${toolCalls.length + 1}`,
        input: input.input,
        outputSummary: input.outputSummary,
        resultEvidenceIds: input.resultEvidenceIds ?? [],
        startedAt: input.startedAt,
        status: input.status,
        stepId: input.stepId,
        toolName: input.toolName,
      };

      toolCalls.push(toolCall);

      return toolCall;
    },
    steps,
    toolCalls,
  };
}

function createRetrieval(evidence, question) {
  return {
    diagnostics: {
      candidateCount: evidence.length,
      embedding: {
        model: "text-embedding-test",
        used: true,
      },
      rerank: {
        model: "rerank-test",
      },
    },
    evidence,
    queryPlan: createQueryPlan(question),
    retrieverVersion: "retriever-test",
    warnings: [],
  };
}

function makeEvidence(chunkId, pageStart, score) {
  return {
    chunkId,
    cloudDocumentId: "doc-1",
    documentTitle: "Current Paper",
    evidenceId: chunkId.replace("chunk-", "C"),
    pageEnd: pageStart,
    pageStart,
    pdfFingerprint: "fp-1",
    score,
    scoreBreakdown: {
      fullText: score / 2,
      metadataBoost: 0.1,
      vector: score,
    },
    text: `Evidence from ${chunkId}.`,
    textPreview: `Evidence from ${chunkId}.`,
  };
}
