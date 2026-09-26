import { isDeepStrictEqual } from "node:util";

// This profile describes a published, additive contract change. It does not
// replace the pre-extraction baseline or remove fields from either artifact.
export const QA_EQUIVALENCE_PROFILE = Object.freeze({
  id: "qa-0.2.0-answer-outline-v1",
  baselineSha: "23ddc3b713b20b34edcceacdb0199da280c39ca0",
  introducedBy: "6eb8db4f6481844420feba2760083b2844353a9c",
  introducedInQaVersion: "0.2.0-alpha.1",
});
export const QA_EQUIVALENCE_SCENARIOS = Object.freeze([
  "search-open-finish", "direct-answer", "carryover", "budget", "unknown-action", "search-error", "heuristic-empty",
]);

export function validateQaEquivalenceScenarios(scenarios) {
  if (!isDeepStrictEqual(scenarios, QA_EQUIVALENCE_SCENARIOS)) {
    throw new Error(`Historical comparison requires the frozen seven scenarios in order: ${QA_EQUIVALENCE_SCENARIOS.join(", ")}`);
  }
}

const outlineChanges = {
  "search-open-finish": {
    index: 7,
    historicalPayload: { answerOutline: "Explain with evidence.", evidenceCount: 1 },
    additions: {
      stopReason: "model_finish",
      action: { action: "finish_retrieval", answerOutline: "Explain with evidence.", evidenceIds: ["C1"] },
    },
  },
  "direct-answer": {
    index: 1,
    historicalPayload: { directAnswer: true, reason: "greeting", replyOutline: "Hello." },
    additions: {
      stopReason: "direct_answer",
      action: { action: "direct_answer", evidenceIds: [], reason: "greeting", replyOutline: "Hello." },
    },
  },
  carryover: {
    index: 1,
    historicalPayload: { evidenceCount: 1 },
    additions: { stopReason: "model_finish", action: { action: "finish_retrieval", evidenceIds: ["C1"] } },
  },
  budget: {
    index: 5,
    historicalPayload: { evidenceCount: 1 },
    // action is undefined in the runner and absent in the serialized artifact;
    // even action: null is an unapproved contract change in this scenario.
    additions: { stopReason: "budget_stop" },
  },
};
const unchangedScenarios = new Set(["unknown-action", "search-error", "heuristic-empty"]);

export function validateQaEquivalenceOptions({ mode, baselineSha }) {
  if (!["strict", "versioned"].includes(mode)) throw new Error(`Unknown comparison mode: ${mode}`);
  if (mode === "versioned" && baselineSha !== QA_EQUIVALENCE_PROFILE.baselineSha) {
    throw new Error(
      `${QA_EQUIVALENCE_PROFILE.id} only supports baseline ${QA_EQUIVALENCE_PROFILE.baselineSha}; ` +
      "use --mode=strict for an explicit alternative historical comparison.",
    );
  }
}

// Union-of-keys comparison catches both deleted historical fields and unknown
// additions, including at the root. Array order/length and absent vs null matter.
function differences(expected, current, path = "$") {
  if (isDeepStrictEqual(expected, current)) return [];
  const object = value => value !== null && typeof value === "object";
  if (!object(expected) || !object(current) || Array.isArray(expected) !== Array.isArray(current)) {
    return [{ path, expected, current, expectedPresent: true, currentPresent: true }];
  }
  const output = [];
  if (Array.isArray(expected) && expected.length !== current.length) {
    output.push({ path: `${path}.length`, expected: expected.length, current: current.length, expectedPresent: true, currentPresent: true });
  }
  for (const key of new Set([...Object.keys(expected), ...Object.keys(current)])) {
    const expectedPresent = Object.hasOwn(expected, key), currentPresent = Object.hasOwn(current, key);
    const childPath = Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`;
    if (!expectedPresent || !currentPresent) {
      output.push({ path: childPath, expected: expected[key], current: current[key], expectedPresent, currentPresent });
    } else output.push(...differences(expected[key], current[key], childPath));
  }
  return output;
}

export function compareQaEquivalence({ scenario, before, after, baselineSha, mode = "versioned" }) {
  validateQaEquivalenceOptions({ mode, baselineSha });
  const historicalDifferences = differences(before, after);
  if (mode === "strict") return { ok: historicalDifferences.length === 0, differences: historicalDifferences, historicalDifferences, acceptedAdditions: [] };

  const change = Object.hasOwn(outlineChanges, scenario) ? outlineChanges[scenario] : undefined;
  if (!change && !unchangedScenarios.has(scenario)) throw new Error(`No ${QA_EQUIVALENCE_PROFILE.id} contract for scenario: ${scenario}`);
  const expected = structuredClone(before), acceptedAdditions = [];
  if (change) {
    const { index, historicalPayload, additions } = change;
    const locations = [
      { step: expected.result?.agentSteps?.[index], path: `$.result.agentSteps[${index}].payload` },
      { step: expected.steps?.[index], path: `$.steps[${index}].payload` },
      { step: expected.events?.[index]?.payload?.step, path: `$.events[${index}].payload.step.payload` },
    ];
    if (expected.events?.[index]?.event !== "agent_step") throw new Error(`Historical ${scenario} event anchor does not match the profile.`);
    for (const { step, path } of locations) {
      if (step?.kind !== "answer_outline" || step?.id !== `step-${index}` || step?.stepIndex !== index || !isDeepStrictEqual(step?.payload, historicalPayload)) {
        throw new Error(`Historical ${scenario} ${path} does not match the profile.`);
      }
      // Build the one permitted new artifact from the old one. Never copy
      // current values into expectations and never globally strip field names.
      Object.assign(step.payload, structuredClone(additions));
      acceptedAdditions.push(...Object.keys(additions).map(key => `${path}.${key}`));
    }
  }
  const remaining = differences(expected, after);
  return {
    ok: remaining.length === 0,
    differences: remaining,
    historicalDifferences,
    acceptedAdditions: remaining.length === 0 ? acceptedAdditions : [],
  };
}
