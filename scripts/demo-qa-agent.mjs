import { runReasoningAgenticRetrieval } from "../server/qa/agent/loop.mjs";
import { runAgenticRetrieval } from "../server/qa/agent/heuristicLoop.mjs";
import { runScenario, scenarioNames } from "../tests/fixtures/qaAgentScenarios.mjs";

const scenario = process.argv[2] ?? "search-open-finish";
if (!scenarioNames.includes(scenario)) {
  console.error(`Choose one: ${scenarioNames.join(", ")}`);
  process.exit(1);
}
const trace = await runScenario(scenario, { runReasoningAgenticRetrieval, runAgenticRetrieval });
console.log(`Offline synthetic QA scenario: ${scenario}`);
for (const { event, payload } of trace.events) {
  console.log(JSON.stringify({ event, stepIndex: payload.step.stepIndex, kind: payload.step.kind, status: payload.step.status, summary: payload.step.summary, tool: payload.toolCall?.toolName, input: payload.toolCall?.input }));
}
console.log(JSON.stringify({ controllerTurns: trace.controllerInputs.length, searches: trace.searches.length, evidence: trace.result?.evidence.map(({ evidenceId, chunkId }) => ({ evidenceId, chunkId })), warnings: trace.result?.warnings, error: trace.error?.message }, null, 2));
