#!/usr/bin/env node
// Guards the "extraction changed no behaviour" claim in docs/qa-agent-runtime.md.
//
// The QA runtime was extracted from a single-file executor into server/qa/agent/*.
// Committed tests only assert what the current code does; they cannot detect that a
// later edit silently changes the public contract. This script reconstructs the
// pre-extraction tree from git history and replays the same synthetic scenarios
// through both implementations, comparing every observable artifact.
//
//   npm run check:agent-equivalence
//   npm run check:agent-equivalence -- --baseline=23ddc3b
//
// Requires full git history: the baseline commit must be reachable. Not part of
// `npm run ci`, because CI checks out with a shallow fetch depth of 1.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Default baseline: the commit the refactor was built on. `240a8fe^` is the same
// commit expressed structurally, so the guard survives a rebase of the branch.
const DEFAULT_BASELINE = "240a8fe^";
const artifact = (value) => JSON.stringify(value ?? null);

function parseBaseline(argv) {
  const flag = argv.find((argument) => argument.startsWith("--baseline="));
  return flag ? flag.slice("--baseline=".length) : DEFAULT_BASELINE;
}

function revisionExists(revision) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const baseline = parseBaseline(process.argv.slice(2));
if (!revisionExists(baseline)) {
  console.error(
    `Baseline revision "${baseline}" is not reachable. Fetch full history ` +
      `(git fetch --unshallow) or pass --baseline=<commit>.`,
  );
  process.exit(2);
}
const baselineSha = execFileSync("git", ["rev-parse", baseline], { encoding: "utf8" }).trim();

const { runScenario, scenarioNames } = await import("../tests/fixtures/qaAgentScenarios.mjs");
const current = await import("../server/qa/agentRunner.mjs");

const workspace = mkdtempSync(join(tmpdir(), "qa-equivalence-"));
let failures = 0;
try {
  // Extract the whole baseline tree, not just the runner, so supporting modules
  // (retriever, query planning, config) are compared as they actually shipped.
  const archive = join(workspace, "baseline.tar");
  execFileSync("git", ["archive", "--format=tar", `--output=${archive}`, baselineSha]);
  execFileSync("tar", ["-xf", archive, "-C", workspace]);
  // Dependencies are not archived; reuse the installed tree.
  symlinkSync(resolve("node_modules"), join(workspace, "node_modules"), "dir");

  const legacyEntry = join(workspace, "server/qa/agentRunner.mjs");
  if (!existsSync(legacyEntry)) {
    console.error(`Baseline ${baselineSha} has no server/qa/agentRunner.mjs; pick an earlier commit.`);
    process.exit(2);
  }
  const legacy = await import(pathToFileURL(legacyEntry).href);

  console.log(`Baseline ${baselineSha} (${baseline}) vs working tree\n`);
  for (const name of scenarioNames) {
    const before = await runScenario(name, legacy);
    const after = await runScenario(name, current);
    const fields = Object.keys(before).filter((key) => artifact(before[key]) !== artifact(after[key]));
    if (fields.length === 0) {
      const shape = [
        `steps=${before.steps.length}`,
        `toolCalls=${before.toolCalls.length}`,
        `events=${before.events.map(({ event }) => event).join("/") || "-"}`,
        `controllerTurns=${before.controllerInputs.length}`,
        `searches=${before.searches.length}`,
        `evidence=${before.result?.evidence?.map(({ evidenceId }) => evidenceId).join(",") || "-"}`,
        `error=${before.error?.name ?? "-"}`,
      ].join(" ");
      console.log(`  ok   ${name.padEnd(20)} ${shape}`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL ${name}`);
    for (const field of fields) {
      console.log(`       ${field} differs:`);
      console.log(`         baseline: ${artifact(before[field]).slice(0, 400)}`);
      console.log(`         current : ${artifact(after[field]).slice(0, 400)}`);
    }
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(
    `\n${failures} of ${scenarioNames.length} scenarios diverged from ${baselineSha}.\n` +
      `Either the change is an intentional contract change (update the docs, the QA\n` +
      `version and the baseline), or it is an unintended regression.`,
  );
  process.exit(1);
}
console.log(
  `\nAll ${scenarioNames.length} scenarios identical to ${baselineSha}: results, persisted\n` +
    `step/tool inputs, event order, controller context and retrieval parameters.`,
);
