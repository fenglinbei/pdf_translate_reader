import assert from "node:assert/strict";
import { test } from "node:test";
import * as runners from "../../server/qa/agentRunner.mjs";
import { runScenario } from "../fixtures/qaAgentScenarios.mjs";
import { createQaControllerAdapter, normalizeControllerAction } from "../../server/qa/agent/controller.mjs";
import { createReasoningBudget } from "../../server/qa/agent/policy.mjs";
import { createQueryPlan } from "../../server/qa/queryPlan.mjs";
import { createAgentEvents } from "../../server/qa/agent/events.mjs";
import { createCurrentPaperToolRegistry } from "../../server/qa/agent/tools.mjs";

test("direct answers skip paper tools and retain the direct-answer result contract", async () => {
  const trace = await runScenario("direct-answer", runners);
  assert.equal(trace.error, undefined);
  assert.equal(trace.result.queryPlan.intent, "direct_answer");
  assert.equal(trace.result.diagnostics.agent.directAnswerReason, "greeting");
  assert.deepEqual(trace.result.evidence, []);
  assert.deepEqual(trace.searches, []);
  assert.deepEqual(trace.toolCalls, []);
  assert.deepEqual(trace.events.map(({ payload }) => payload.step.kind), ["plan", "answer_outline"]);
});

test("quick budget clamps topK and stops a controller repeatedly asking to search", async () => {
  const trace = await runScenario("budget", runners);
  assert.equal(trace.error, undefined);
  assert.equal(trace.searches.length, 1);
  assert.equal(trace.searches[0].matchCount, 6);
  assert.equal(trace.controllerInputs.length, 2);
  assert.match(trace.result.warnings.join(" "), /budget was exhausted/);
  assert.equal(trace.result.evidence[0].evidenceId, "C1");
});

test("each model turn sees prior observations and opening a chunk changes the next turn", async () => {
  const trace = await runScenario("search-open-finish", runners);
  assert.equal(trace.error, undefined);
  assert.deepEqual(trace.controllerInputs[0].evidence, []);
  assert.equal(trace.controllerInputs[1].evidence[0].evidenceId, "C1");
  assert.deepEqual(trace.controllerInputs[1].openedEvidenceIds, []);
  assert.deepEqual(trace.controllerInputs[2].openedEvidenceIds, ["C1"]);
  assert.equal(trace.controllerInputs[2].toolHistory.at(-1).action, "open_chunk");
  assert.deepEqual(trace.events.map(({ event }) => event), ["agent_step", "gap_check", "tool_call", "observation", "gap_check", "tool_call", "observation", "agent_step"]);
  assert.deepEqual(trace.steps.map(({ stepIndex }) => stepIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("failed retrieval preserves the error timeline and never emits a success outline", async () => {
  const trace = await runScenario("search-error", runners);
  assert.equal(trace.result, undefined);
  assert.equal(trace.error.name, "QaAgentRunnerError");
  assert.equal(trace.error.nextStepIndex, 3);
  assert.equal(trace.error.agentSteps.at(-1).toolCall.status, "error");
  assert.equal(trace.toolCalls[0].errorMessage, "synthetic retrieval unavailable");
  assert.deepEqual(trace.events.map(({ event }) => event), ["agent_step", "gap_check", "tool_call"]);
});

function controllerInput() {
  const queryPlan = createQueryPlan("Explain the method");
  return {
    queryPlan, question: "Explain the method", budget: createReasoningBudget("standard", queryPlan),
    evidence: [{ evidenceId: "C1", pageStart: 2, textPreview: "preview", text: "full evidence text", score: 0.8 }],
    openedEvidenceIds: [], toolHistory: [], turnIndex: 0, model: "deepseek-v4-pro", signal: new AbortController().signal,
  };
}

test("model adapter preserves model, cancellation and bounded evidence context", async () => {
  const calls = [];
  const adapter = createQaControllerAdapter({ complete: async (input) => {
    calls.push(input);
    return { content: '{"action":"finish_retrieval","evidenceIds":["C1"]}' };
  } });
  const input = controllerInput();
  input.toolHistory = Array.from({ length: 9 }, (_, turn) => ({ turn }));
  assert.equal((await adapter(input)).action, "finish_retrieval");
  await adapter({ ...input, openedEvidenceIds: ["C1"] });
  assert.equal(calls[0].model, input.model);
  assert.equal(calls[0].signal, input.signal);
  assert.equal(calls[0].temperature, 0.1);
  const first = JSON.parse(calls[0].messages[1].content);
  const opened = JSON.parse(calls[1].messages[1].content);
  assert.equal(first.currentEvidence[0].preview, "preview");
  assert.equal(opened.currentEvidence[0].preview, "full evidence text");
  assert.deepEqual(first.toolHistory.map(({ turn }) => turn), [3, 4, 5, 6, 7, 8]);
  const long = "x".repeat(4000);
  await adapter({ ...input, evidence: [{ ...input.evidence[0], text: long, textPreview: long }] });
  await adapter({ ...input, evidence: [{ ...input.evidence[0], text: long }], openedEvidenceIds: ["C1"] });
  assert.equal(JSON.parse(calls[2].messages[1].content).currentEvidence[0].preview.length, 800);
  assert.equal(JSON.parse(calls[3].messages[1].content).currentEvidence[0].preview.length, 3000);
});

test("adapter tolerates existing JSON wrappers but rejects malformed and unknown actions", async () => {
  for (const content of ['{"action":"direct_answer"}', '```json\n{"action":"direct_answer"}\n```', 'Response: {"action":"direct_answer"}']) {
    const adapter = createQaControllerAdapter({ complete: async () => ({ content }) });
    assert.equal(normalizeControllerAction(await adapter(controllerInput())).action, "direct_answer");
  }
  const invalid = createQaControllerAdapter({ complete: async () => ({ content: "not JSON" }) });
  await assert.rejects(() => invalid(controllerInput()), /invalid JSON/);
  for (const action of [null, [], { action: "search_library" }, { action: "__proto__" }]) assert.throws(() => normalizeControllerAction(action));
  const aborted = createQaControllerAdapter({ complete: async ({ signal }) => { signal.throwIfAborted(); } });
  await assert.rejects(() => aborted({ ...controllerInput(), signal: AbortSignal.abort(new Error("cancelled")) }), /cancelled/);
});

function runtimeState() {
  return { agentSteps: [], nextStepIndex: 0, maxSteps: 10, messageId: "message", userId: "trusted-user" };
}

test("tool registry binds authorized document and user instead of trusting model fields", async () => {
  const searches = [], emitted = [], persistedCalls = [];
  const signal = new AbortController().signal;
  const events = createAgentEvents({
    insertStep: async (input) => ({ ...input, id: `step-${input.stepIndex}` }),
    insertToolCall: async (input) => { persistedCalls.push(input); return { ...input, id: "tool-1" }; },
    emit: (...args) => emitted.push(args),
  });
  const registry = createCurrentPaperToolRegistry({ events, signal, userDocumentId: "trusted-paper", userId: "trusted-user", retrieveEvidence: async (input) => { searches.push(input); return { evidence: [] }; } });
  const state = runtimeState();
  await registry.execute("search_current_paper", { query: "method", userId: "attacker", userDocumentId: "other-paper", scope: "library" }, { state });
  assert.equal(searches[0].userId, "trusted-user");
  assert.equal(searches[0].userDocumentId, "trusted-paper");
  assert.equal(searches[0].signal, signal);
  assert.equal(persistedCalls[0].input.scope, "current");
  assert.equal(persistedCalls[0].userId, "trusted-user");
  for (const name of ["search_library", "__proto__", "constructor"]) await assert.rejects(() => registry.execute(name, {}, { state }), /Unregistered/);
  assert.equal(searches.length, 1);
  const opened = await registry.execute("open_chunk", { evidenceIds: ["C99"] }, { state, evidence: [], openedEvidenceIds: new Set() });
  assert.deepEqual(opened, []);
  assert.equal(emitted.at(-1)[1].toolCall.status, "skipped");
});

test("events publish only after persistence and failed writes do not advance the timeline", async () => {
  const order = [], state = runtimeState();
  const events = createAgentEvents({
    insertStep: async (input) => { order.push("persist-step"); return { ...input, id: "step-0" }; },
    insertToolCall: async (input) => { order.push("persist-tool"); return { ...input, id: "tool-0" }; },
    emit: (name) => order.push(`emit-${name}`),
  });
  const step = await events.recordStep(state, "agent_step", { kind: "plan", summary: "Plan." });
  await events.recordToolCall(state, step, { toolName: "search_current_paper" });
  assert.deepEqual(order, ["persist-step", "emit-agent_step", "persist-tool", "emit-tool_call"]);
  assert.equal(state.agentSteps[0].toolCall.id, "tool-0");
  const failure = createAgentEvents({ insertStep: async () => { throw new Error("database unavailable"); }, emit: () => assert.fail("must not publish an unpersisted step") });
  await assert.rejects(() => failure.recordStep(state, "agent_step", { kind: "plan" }), /database unavailable/);
  assert.equal(state.nextStepIndex, 1);
  assert.equal(state.agentSteps.length, 1);
});

test("event step limit preserves the existing skipped-step contract", async () => {
  const state = { ...runtimeState(), maxSteps: 0 };
  const events = createAgentEvents({ insertStep: () => assert.fail("step budget exhausted"), emit: () => assert.fail("no event beyond step limit") });
  const skipped = await events.recordStep(state, "agent_step", { kind: "answer_outline" });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.id, "skipped-step-0");
  assert.deepEqual(state.agentSteps, []);
});
