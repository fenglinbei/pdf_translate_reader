import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function validateVersion(version) {
  const integer = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${integer}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
  if (!new RegExp(`^${integer}\\.${integer}\\.${integer}(?:-${identifier}(?:\\.${identifier})*)?$`).test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  return version;
}

export function checkRelease({ tag = process.env.QA_RELEASE_TAG, environment = process.env.QA_RELEASE_ENVIRONMENT } = {}) {
  const app = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
  const qa = JSON.parse(readFileSync(new URL("../server/qa/package.json", import.meta.url)));
  validateVersion(app.version);
  validateVersion(qa.version);
  if (app.version !== lock.version || app.version !== lock.packages[""].version) throw new Error("App version and lockfile differ.");
  if (tag && tag !== `qa-v${qa.version}`) throw new Error("QA tag must match server/qa/package.json.");
  if (environment === "qa-production" && qa.version.includes("-")) throw new Error("Production requires a stable QA version.");
  console.log(`Versions: app=${app.version}, qa=${qa.version}`);
  return { app: app.version, qa: qa.version };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkRelease();
