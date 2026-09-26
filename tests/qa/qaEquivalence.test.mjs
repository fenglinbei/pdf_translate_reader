import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareQaEquivalence, validateQaEquivalenceOptions, validateQaEquivalenceScenarios } from "../../scripts/lib/qaEquivalence.mjs";

const baselineSha = "23ddc3b713b20b34edcceacdb0199da280c39ca0";
// Independently recorded outline payloads from the original/P2 trajectories.
// Fixtures deliberately retain old fields and all three observable copies so a
// normalizer that merely drops stopReason/action cannot pass these tests.
const cases = [
  ["search-open-finish", 7,
    { answerOutline: "Explain with evidence.", evidenceCount: 1 },
    { answerOutline: "Explain with evidence.", evidenceCount: 1, stopReason: "model_finish", action: { action: "finish_retrieval", answerOutline: "Explain with evidence.", evidenceIds: ["C1"] } }],
  ["direct-answer", 1,
    { directAnswer: true, reason: "greeting", replyOutline: "Hello." },
    { directAnswer: true, reason: "greeting", replyOutline: "Hello.", stopReason: "direct_answer", action: { action: "direct_answer", evidenceIds: [], reason: "greeting", replyOutline: "Hello." } }],
  ["carryover", 1,
    { evidenceCount: 1 },
    { evidenceCount: 1, stopReason: "model_finish", action: { action: "finish_retrieval", evidenceIds: ["C1"] } }],
  ["budget", 5,
    { evidenceCount: 1 },
    { evidenceCount: 1, stopReason: "budget_stop" }],
];
const clone = structuredClone;
function fixture(index, payload) {
  const steps = Array.from({ length: index + 1 }, (_, stepIndex) => ({
    id: `step-${stepIndex}`, stepIndex, kind: stepIndex === index ? "answer_outline" : "plan",
    payload: stepIndex === index ? clone(payload) : { query: "unchanged" },
    messageId: "synthetic-message", userId: "authorized-user", evidenceIds: [],
  }));
  return {
    result: { evidence: [{ evidenceId: "C1", text: "A synthetic method." }], agentSteps: clone(steps) },
    steps,
    events: steps.map(step => ({ event: "agent_step", payload: { step: clone(step) } })),
    toolCalls: [{ input: { query: "contrastive method" }, userId: "authorized-user" }],
    controllerInputs: [{ turnIndex: 0, question: "Explain the method" }],
    searches: [{ userDocumentId: "authorized-document", userId: "authorized-user" }],
  };
}
function payloads(trace, index) {
  return [trace.result.agentSteps[index].payload, trace.steps[index].payload, trace.events[index].payload.step.payload];
}
function compare(scenario, before, after, mode = "versioned") {
  return compareQaEquivalence({ scenario, before, after, baselineSha, mode });
}

describe("versioned historical QA equivalence", () => {
  for (const [scenario, index, historical, published] of cases) {
    const before = fixture(index, historical), after = fixture(index, published);

    it(`${scenario}: accepts the exact published additions without changing either input`, () => {
      const initialBefore = clone(before), initialAfter = clone(after);
      const result = compare(scenario, before, after);
      assert.equal(result.ok, true);
      assert.equal(result.acceptedAdditions.length, scenario === "budget" ? 3 : 6);
      assert.ok(result.historicalDifferences.length > 0);
      assert.deepEqual(before, initialBefore);
      assert.deepEqual(after, initialAfter);
      assert.equal(compare(scenario, before, after, "strict").ok, false);
      assert.equal(compare(scenario, before, before, "strict").ok, true);
      // Metadata is now required, not simply ignored if present.
      assert.equal(compare(scenario, before, before).ok, false);
    });

    it(`${scenario}: rejects wrong/missing stop reasons in each observable copy`, () => {
      for (let surface = 0; surface < 3; surface++) {
        for (const value of ["unknown", "direct_answer", "model_finish", "budget_stop", null]) {
          if (value === published.stopReason) continue;
          const changed = clone(after);
          payloads(changed, index)[surface].stopReason = value;
          assert.equal(compare(scenario, before, changed).ok, false, `surface ${surface}, value ${value}`);
        }
        const changed = clone(after);
        delete payloads(changed, index)[surface].stopReason;
        assert.equal(compare(scenario, before, changed).ok, false);
      }
    });

    it(`${scenario}: rejects deleted/changed historical fields and unknown payload fields`, () => {
      for (let surface = 0; surface < 3; surface++) {
        for (const key of Object.keys(historical)) {
          const removed = clone(after), changed = clone(after);
          delete payloads(removed, index)[surface][key];
          payloads(changed, index)[surface][key] = "silently changed";
          assert.equal(compare(scenario, before, removed).ok, false, `deleted ${key}, surface ${surface}`);
          assert.equal(compare(scenario, before, changed).ok, false, `changed ${key}, surface ${surface}`);
        }
        const extra = clone(after);
        payloads(extra, index)[surface].unexpected = true;
        assert.equal(compare(scenario, before, extra).ok, false);
      }
    });

    it(`${scenario}: rejects missing, incorrect and expanded action objects`, () => {
      for (let surface = 0; surface < 3; surface++) {
        for (const badAction of [null, {}, { action: "finish_retrieval", evidenceIds: ["C999"] }, { ...(published.action ?? {}), unexpected: true }]) {
          const changed = clone(after);
          payloads(changed, index)[surface].action = badAction;
          assert.equal(compare(scenario, before, changed).ok, false);
        }
        if (published.action) {
          const removed = clone(after);
          delete payloads(removed, index)[surface].action;
          assert.equal(compare(scenario, before, removed).ok, false);
          for (const key of Object.keys(published.action)) {
            const changed = clone(after);
            delete payloads(changed, index)[surface].action[key];
            assert.equal(compare(scenario, before, changed).ok, false, `missing action.${key}, surface ${surface}`);
          }
        }
      }
    });
  }

  it("requires the exact historical SHA and rejects unknown profile/mode/scenario names", () => {
    assert.throws(() => validateQaEquivalenceOptions({ mode: "versioned", baselineSha: "HEAD" }), /only supports baseline/);
    assert.throws(() => validateQaEquivalenceOptions({ mode: "normalized", baselineSha }), /Unknown comparison mode/);
    assert.doesNotThrow(() => validateQaEquivalenceOptions({ mode: "strict", baselineSha: "another-resolved-sha" }));
    assert.throws(() => compare("new-scenario", {}, {}), /No .* contract/);
  });

  it("does not allow deleting, duplicating or silently replacing frozen scenarios", () => {
    const names = ["search-open-finish", "direct-answer", "carryover", "budget", "unknown-action", "search-error", "heuristic-empty"];
    assert.doesNotThrow(() => validateQaEquivalenceScenarios(names));
    for (const changed of [names.slice(0, -1), [...names, "new-case"], [...names.slice(0, -1), names[0]], [...names].reverse()]) {
      assert.throws(() => validateQaEquivalenceScenarios(changed), /frozen seven scenarios/);
    }
  });

  it("rejects changes outside the approved fields, including root additions and array order", () => {
    const [scenario, index, historical, published] = cases[0];
    const before = fixture(index, historical), after = fixture(index, published);
    const mutations = [
      t => { t.unexpected = true; },
      t => { delete t.searches; },
      t => { t.result.evidence[0].evidenceId = "C999"; },
      t => { t.toolCalls[0].userId = "another-user"; },
      t => { t.controllerInputs[0].turnIndex = 99; },
      t => { t.searches[0].userDocumentId = "another-document"; },
      t => { t.steps[0].payload.stopReason = "model_finish"; },
      t => { t.steps[index - 1].payload = t.steps[index].payload; },
      t => { t.events.reverse(); },
      t => { t.events[index].event = "observation"; },
      t => { t.events[index].payload.step.id = "different-step"; },
      t => { t.result.agentSteps.pop(); },
      t => { t.controllerInputs.length += 1; },
    ];
    for (const mutate of mutations) {
      const changed = clone(after); mutate(changed);
      const result = compare(scenario, before, changed);
      assert.equal(result.ok, false, String(mutate));
      assert.equal(result.acceptedAdditions.length, 0);
    }
  });

  it("refuses a changed historical anchor instead of laundering it through the profile", () => {
    const [scenario, index, historical, published] = cases[0];
    for (let surface = 0; surface < 3; surface++) {
      const before = fixture(index, historical);
      payloads(before, index)[surface].unexpected = true;
      assert.throws(() => compare(scenario, before, fixture(index, published)), /does not match the profile/);
    }
    const before = fixture(index, historical);
    before.events[index].event = "observation";
    assert.throws(() => compare(scenario, before, fixture(index, published)), /event anchor/);
  });

  for (const scenario of ["unknown-action", "search-error", "heuristic-empty"]) {
    it(`${scenario}: permits no metadata or other changes`, () => {
      const before = fixture(1, { evidenceCount: 0 });
      before.error = { name: "QaAgentRunnerError", agentSteps: clone(before.steps) };
      assert.equal(compare(scenario, before, clone(before)).ok, true);
      const after = clone(before);
      payloads(after, 1).forEach(payload => { payload.stopReason = "budget_stop"; });
      assert.equal(compare(scenario, before, after).ok, false);
      const errorChanged = clone(before);
      errorChanged.error.agentSteps[1].payload.action = { action: "direct_answer" };
      assert.equal(compare(scenario, before, errorChanged).ok, false);
    });
  }

  it("strict mode distinguishes absence, null and unknown top-level additions", () => {
    for (const [before, after] of [[{}, { extra: null }], [{ kept: null }, {}], [{ kept: 0 }, { kept: null }]]) {
      const result = compare("strict-only", before, after, "strict");
      assert.equal(result.ok, false);
      assert.equal(result.differences.length, 1);
    }
  });
});
