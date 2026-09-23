import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateVersion, checkRelease } from "../../scripts/check-release.mjs";

test("release identity rejects mismatched tags and prereleases in production", () => {
  for (const value of ["0.1.0", "0.1.0-alpha.1", "1.2.3-rc.4"]) assert.equal(validateVersion(value), value);
  for (const value of ["v1.0.0", "01.0.0", "1.0.0-01", "1.0", "1.0.0+mutable"]) assert.throws(() => validateVersion(value));
  const { qa } = checkRelease();
  assert.throws(() => checkRelease({ tag: "qa-v9.9.9" }), /tag must match/);
  if (qa.includes("-")) assert.throws(() => checkRelease({ environment: "qa-production" }), /stable/);
});

test("QA deploy switches only QA and rolls back failed restart or health verification", () => {
  const temp = mkdtempSync(join(tmpdir(), "qa-rollback-test-"));
  try {
    const source = join(temp, "source");
    const bin = join(temp, "bin");
    mkdirSync(join(source, "server/qa"), { recursive: true });
    mkdirSync(bin);
    const sha = "c".repeat(40);
    writeFileSync(join(source, "qa-release.json"), JSON.stringify({ service: "pdf-reader-qa", version: "0.1.0-alpha.1", sha }));
    writeFileSync(join(source, "server/qa/package.json"), JSON.stringify({ version: "0.1.0-alpha.1" }));
    const archive = join(temp, "qa.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    const commands = {
      npm: 'printf "npm %s\\n" "$*" >> "$COMMAND_LOG"; exit "${NPM_STATUS:-0}"',
      sudo: 'printf "sudo %s\\n" "$*" >> "$COMMAND_LOG"; if [[ "${RESTART_FAIL:-0}" == 1 && ! -f "$FAILED_ONCE" ]]; then touch "$FAILED_ONCE"; exit 1; fi',
      curl: 'printf \'{"status":"ok","service":"pdf-reader-qa","sha":"%s"}\\n\' "$HEALTH_SHA"',
      sleep: 'exit 0',
    };
    for (const [name, script] of Object.entries(commands)) {
      writeFileSync(join(bin, name), `#!/usr/bin/env bash\nset -eu\n${script}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    for (const scenario of ["success", "restart", "health", "install"]) {
      const root = join(temp, scenario);
      const previous = join(root, "releases", "previous");
      mkdirSync(previous, { recursive: true });
      writeFileSync(join(root, ".qa-deploy-root"), "pdf-reader-qa-staging.service\n");
      symlinkSync(previous, join(root, "current"));
      const log = join(root, "commands.log");
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, FAILED_ONCE: join(root, "failed"), QA_DEPLOY_ROOT: root, QA_SERVICE_NAME: "pdf-reader-qa-staging.service", QA_HEALTH_URL: "http://127.0.0.1:8788/api/qa/health", QA_DEPLOY_DRY_RUN: "0", HEALTH_SHA: scenario === "health" ? "wrong" : sha, RESTART_FAIL: scenario === "restart" ? "1" : "0", NPM_STATUS: scenario === "install" ? "1" : "0" };
      const deploy = () => execFileSync("bash", [resolve("scripts/deploy-qa.sh"), archive, sha], { env, encoding: "utf8", stdio: "pipe" });
      if (scenario === "success") assert.match(deploy(), /QA deployed/);
      else assert.throws(deploy);
      assert.equal(readlinkSync(join(root, "current")), scenario === "success" ? join(root, "releases", sha) : previous);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      assert.equal(calls[0], "npm ci --omit=dev --ignore-scripts");
      assert.equal(calls.length, scenario === "install" ? 1 : scenario === "success" ? 2 : 3);
      for (const call of calls.slice(1)) assert.equal(call, "sudo -n systemctl restart pdf-reader-qa-staging.service");
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("QA deployment verifies identity, limits service scope, and validates without mutating the active release", () => {
  const temp = mkdtempSync(join(tmpdir(), "qa-release-test-"));
  try {
    const root = join(temp, "qa");
    const source = join(temp, "source");
    mkdirSync(root);
    mkdirSync(join(source, "server/qa"), { recursive: true });
    const sha = "a".repeat(40);
    writeFileSync(join(root, ".qa-deploy-root"), "pdf-reader-qa-staging.service\n");
    writeFileSync(join(source, "qa-release.json"), JSON.stringify({ service: "pdf-reader-qa", version: "0.1.0-alpha.1", sha }));
    writeFileSync(join(source, "server/qa/package.json"), JSON.stringify({ version: "0.1.0-alpha.1" }));
    const archive = join(temp, "qa.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    const env = { ...process.env, QA_DEPLOY_ROOT: root, QA_SERVICE_NAME: "pdf-reader-qa-staging.service", QA_HEALTH_URL: "http://127.0.0.1:8788/api/qa/health", QA_DEPLOY_DRY_RUN: "1" };
    const run = (next = env, expected = sha) => execFileSync("bash", ["scripts/deploy-qa.sh", archive, expected], { env: next, encoding: "utf8", stdio: "pipe" });
    assert.match(run(), /Validated QA release/);
    assert.throws(() => run(env, "b".repeat(40)));
    assert.throws(() => run({ ...env, QA_SERVICE_NAME: "pdf-translate-reader.service" }));
    assert.throws(() => run({ ...env, QA_HEALTH_URL: "http://127.0.0.1:8787/api/health" }));
    assert.throws(() => readFileSync(join(root, "current")));
    symlinkSync("/tmp", join(source, "bad-link"));
    execFileSync("tar", ["-czf", archive, "-C", source, "."]);
    assert.throws(() => run());
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
