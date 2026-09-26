#!/usr/bin/env node
// Replays the original extraction baseline plus explicitly versioned changes.
//
// The QA runtime was extracted from a single-file executor into server/qa/agent/*.
// Committed tests only assert what the current code does; they cannot detect that a
// later edit silently changes the public contract. This script reconstructs the
// pre-extraction tree from git history and replays the same synthetic scenarios
// through both implementations, comparing every observable artifact. The default
// accepts only the documented QA 0.2.0 outline additions. Strict mode retains the
// historical exact comparison, including intentional later contract changes.
//
//   npm run check:agent-equivalence
//   npm run check:agent-equivalence -- --mode=strict
//   npm run check:agent-equivalence -- --mode=strict --baseline=23ddc3b
//
// Requires full git history: the baseline commit must be reachable. Not part of
// `npm run ci`, because CI checks out with a shallow fetch depth of 1.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareQaEquivalence, QA_EQUIVALENCE_PROFILE, validateQaEquivalenceOptions, validateQaEquivalenceScenarios } from "./lib/qaEquivalence.mjs";

// Pin the original commit, not a mutable branch name or today's HEAD.
const DEFAULT_BASELINE = QA_EQUIVALENCE_PROFILE.baselineSha;
const artifact = value => JSON.stringify(value);

function parseOptions(argv) {
  const options = { baseline: DEFAULT_BASELINE, mode: "versioned" }, seen = new Set();
  for (const argument of argv) {
    const match = /^--(baseline|mode)=(.+)$/.exec(argument);
    if (!match || seen.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    seen.add(match[1]); options[match[1]] = match[2];
  }
  return options;
}

let baseline, baselineSha, mode;
try {
  ({ baseline, mode } = parseOptions(process.argv.slice(2)));
  baselineSha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${baseline}^{commit}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  validateQaEquivalenceOptions({ mode, baselineSha });
} catch (error) {
  console.error(`Cannot initialize historical comparison: ${error.message}`);
  if (error.code === "EPERM" || error.code === "EACCES") console.error("Git subprocess access was denied; rerun with authorized local execution permissions.");
  else if (error.status) console.error("Verify the revision and full local history (git fetch --unshallow if needed).");
  process.exit(2);
}

const { runScenario, scenarioNames } = await import("../tests/fixtures/qaAgentScenarios.mjs");
try {
  validateQaEquivalenceScenarios(scenarioNames);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const current = await import("../server/qa/agentRunner.mjs");

const workspace = mkdtempSync(join(tmpdir(), "qa-equivalence-"));
let failures = 0;
let compatibleScenarios = 0;
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
    throw new Error(`Baseline ${baselineSha} has no server/qa/agentRunner.mjs.`);
  }
  const legacy = await import(pathToFileURL(legacyEntry).href);

  console.log(`Baseline ${baselineSha} vs working tree; mode=${mode}`);
  if (mode === "versioned") console.log(`Compatibility profile: ${QA_EQUIVALENCE_PROFILE.id} (introduced by ${QA_EQUIVALENCE_PROFILE.introducedBy})`);
  console.log();
  for (const name of scenarioNames) {
    const before = await runScenario(name, legacy);
    const after = await runScenario(name, current);
    const comparison = compareQaEquivalence({ scenario: name, before, after, baselineSha, mode });
    if (comparison.ok) {
      if (comparison.acceptedAdditions.length) compatibleScenarios += 1;
      const shape = [
        `steps=${before.steps.length}`,
        `toolCalls=${before.toolCalls.length}`,
        `events=${before.events.map(({ event }) => event).join("/") || "-"}`,
        `controllerTurns=${before.controllerInputs.length}`,
        `searches=${before.searches.length}`,
        `evidence=${before.result?.evidence?.map(({ evidenceId }) => evidenceId).join(",") || "-"}`,
        `error=${before.error?.name ?? "-"}`,
      ].join(" ");
      const label = comparison.acceptedAdditions.length ? `compatible (${comparison.acceptedAdditions.length} exact additions)` : "identical";
      console.log(`  ok   ${name.padEnd(20)} ${label}; ${shape}`);
      continue;
    }
    failures += 1;
    console.log(`  FAIL ${name}`);
    for (const difference of comparison.differences) {
      console.log(`       ${difference.path} differs:`);
      console.log(`         expected: ${difference.expectedPresent ? artifact(difference.expected) : "<absent>"}`);
      console.log(`         current : ${difference.currentPresent ? artifact(difference.current) : "<absent>"}`);
    }
  }
} catch (error) {
  console.error(`Historical comparison could not complete: ${error.message}`);
  process.exitCode = 2;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (process.exitCode === 2) process.exit(2);

if (failures > 0) {
  console.error(
    `\n${failures} of ${scenarioNames.length} scenarios diverged from ${baselineSha}.\n` +
      (mode === "strict"
        ? "Strict mode includes published contract additions; use versioned mode to validate their precise allowed shape.\n"
        : "Unexpected contract drift. Investigate before proposing a separately reviewed compatibility profile.\n") +
      "Do not replace the historical baseline with HEAD to make this check pass.",
  );
  process.exit(1);
}
console.log(
  `\nAll ${scenarioNames.length} scenarios passed: ${scenarioNames.length - compatibleScenarios} identical, ${compatibleScenarios} version-compatible.\n` +
    "Compared complete results, persisted step/tool inputs, event order, controller context and retrieval parameters.",
);
