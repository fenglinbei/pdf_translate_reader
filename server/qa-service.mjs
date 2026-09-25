import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

// Explicit configuration prevents a development process from inheriting the
// repository's production .env.local and recovering real indexing jobs.
if (!process.env.QA_ENV_FILE) throw new Error("QA_ENV_FILE is required; use a dedicated QA environment file.");
const loaded = loadDotenv({ path: process.env.QA_ENV_FILE, override: true });
if (loaded.error) throw loaded.error;
if (!["development", "staging", "production"].includes(process.env.QA_ENVIRONMENT)) {
  throw new Error("QA_ENVIRONMENT must be development, staging, or production.");
}
const port = Number(process.env.QA_PORT ?? 8788);
const runtime = process.env.QA_AGENT_RUNTIME ?? 'legacy-json-v1';
if (!['legacy-json-v1', 'document-tools-v1', 'workspace-tools-v1', 'workspace-artifacts-v1'].includes(runtime)) throw new Error('Invalid QA_AGENT_RUNTIME.');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid QA_PORT.");

const { createQaServer } = await import("./qa/httpServer.mjs");
const { requireAuthenticatedUser } = await import("./supabase/auth.mjs");
const { handleQaRoute } = await import("./routes/qa.mjs");
const { checkQaDocumentSchema } = await import('./qa/documents/schema.mjs');
await checkQaDocumentSchema();
if ((process.env.QA_DOCUMENT_ARTIFACTS_ENABLED === 'true' || runtime === 'workspace-artifacts-v1')) {
  const { checkArtifactSchema } = await import('./qa/documentArtifacts/repository.mjs');
  await checkArtifactSchema();
}
if (['workspace-tools-v1', 'workspace-artifacts-v1'].includes(runtime)) {
  const { checkWorkspaceSchema } = await import('./qa/workspace/repository.mjs');
  await checkWorkspaceSchema();
}
const { version } = JSON.parse(readFileSync(new URL("./qa/package.json", import.meta.url), "utf8"));
let sha = "development";
try {
  sha = JSON.parse(readFileSync(new URL("../qa-release.json", import.meta.url), "utf8")).sha;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  if (process.env.QA_ENVIRONMENT === "production") throw new Error("Production requires a packaged QA release.");
}
const server = createQaServer({
  authenticate: requireAuthenticatedUser,
  handleRoute: handleQaRoute,
  release: { version, sha, environment: process.env.QA_ENVIRONMENT, runtime },
});
server.listen(port, "127.0.0.1", () => {
  console.log(`QA service listening on http://127.0.0.1:${port}`);
  if (process.env.QA_INDEX_WORKER_ENABLED === "true") {
    import("./qa/indexJobRunner.mjs")
      .then(({ recoverQaIndexJobs }) => recoverQaIndexJobs())
      .catch(() => console.warn("QA index recovery failed; inspect the QA service configuration."));
  }
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}
