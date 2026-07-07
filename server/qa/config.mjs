export const QA_PROMPT_VERSION = "qa-answer-v1";
export const QA_CHUNKER_VERSION = "qa-chunker-v2";
export const QA_REFERENCE_MATCHER_VERSION = "reference-matcher-v1";
export const QA_RETRIEVER_VERSION = "hybrid-retriever-v1";
export const QA_AGENT_RUNNER_VERSION = "agent-runner-v1";
export const QA_LONG_CONTEXT_MAX_CHARS = normalizePositiveInteger(
  process.env.QA_LONG_CONTEXT_MAX_CHARS,
  240000,
);
export const QA_QUERY_ROUTER_VERSION = "query-router-v1";

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
