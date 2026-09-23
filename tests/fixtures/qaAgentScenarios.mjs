// Synthetic, offline scenarios shared by compatibility checks and the learning demo.
export const scenarioNames = ["search-open-finish", "direct-answer", "carryover", "budget", "unknown-action", "search-error", "heuristic-empty"];

export async function runScenario(name, runners) {
  const steps = [], toolCalls = [], events = [], controllerInputs = [], searches = [];
  const evidence = [{ chunkId: "chunk-7", evidenceId: "C7", pageStart: 3, pageEnd: 3, score: 0.9, text: "A synthetic method uses contrastive training.", textPreview: "A synthetic method...", sectionPath: ["Method"] }];
  const actions = {
    "search-open-finish": [
      { action: "search_current_paper", query: "contrastive method", topK: 4 },
      { action: "open_chunk", evidenceIds: ["C1"] },
      { action: "finish_retrieval", evidenceIds: ["C1"], answerOutline: "Explain with evidence." },
    ],
    "direct-answer": [{ action: "direct_answer", reason: "greeting", replyOutline: "Hello." }],
    carryover: [{ action: "finish_retrieval", evidenceIds: ["C1"] }],
    budget: Array.from({ length: 3 }, () => ({ action: "search_current_paper", query: "try again", topK: 99 })),
    "unknown-action": [{ action: "search_library" }],
    "search-error": [{ action: "search_current_paper" }],
  };
  if (!scenarioNames.includes(name)) throw new Error(`Unknown scenario: ${name}`);
  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  let result, error;
  const input = {
    messageId: "synthetic-message", model: "deepseek-v4-pro", question: "Explain the method", reasoningEffort: name === "budget" ? "quick" : "standard",
    userDocumentId: "authorized-document", userId: "authorized-user", signal: new AbortController().signal,
    insertStep: async (value) => {
      const step = { ...value, id: `step-${steps.length}`, createdAt: 1700000000000 };
      steps.push(snapshot(step));
      return step;
    },
    insertToolCall: async (value) => {
      const call = { ...value, id: `tool-${toolCalls.length}` };
      toolCalls.push(snapshot(call));
      return call;
    },
    emit: (event, payload) => events.push({ event, payload: snapshot(payload) }),
    callController: async (value) => {
      controllerInputs.push(snapshot(value));
      return actions[name].shift();
    },
    retrieveEvidence: async (value) => {
      searches.push(snapshot(value));
      if (name === "search-error") throw new Error("synthetic retrieval unavailable");
      return { evidence: name === "heuristic-empty" ? [] : evidence, diagnostics: { candidateCount: 1, embedding: { used: true } }, retrieverVersion: "synthetic", warnings: [] };
    },
  };
  if (name === "carryover") input.chatContext = {
    carryoverEvidence: evidence, mentionedEvidenceIds: ["C7"], userIntent: "follow_up",
    recentMessages: [{ role: "assistant", content: "Previous evidence [C7]." }],
  };
  // Deterministic tool timing for comparing the old and extracted runtimes.
  const now = Date.now;
  Date.now = () => 1700000000000;
  try {
    const runner = name === "heuristic-empty" ? runners.runAgenticRetrieval : runners.runReasoningAgenticRetrieval;
    result = await runner(input);
  } catch (caught) {
    error = { name: caught.name, message: caught.message, nextStepIndex: caught.nextStepIndex, agentSteps: caught.agentSteps };
  } finally { Date.now = now; }
  return snapshot({ result, error, steps, toolCalls, events, controllerInputs, searches });
}
