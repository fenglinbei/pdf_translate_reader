const DEFAULT_VOYAGE_API_BASE_URL = "https://api.voyageai.com";
const DEFAULT_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_EMBEDDING_DIMENSIONS = 1024;
const DEFAULT_EMBEDDING_BATCH_SIZE = 8;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 60000;

export function getEmbeddingRuntimeConfig() {
  const provider = normalizeProvider(process.env.EMBEDDING_PROVIDER, process.env.VOYAGE_API_KEY);
  const dimensions = normalizePositiveInteger(
    process.env.EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_DIMENSIONS,
  );

  return {
    apiBaseUrl: process.env.VOYAGE_API_BASE_URL ?? DEFAULT_VOYAGE_API_BASE_URL,
    apiKey: process.env.VOYAGE_API_KEY,
    batchSize: normalizePositiveInteger(
      process.env.EMBEDDING_BATCH_SIZE,
      DEFAULT_EMBEDDING_BATCH_SIZE,
    ),
    configured: provider === "voyage" && Boolean(process.env.VOYAGE_API_KEY),
    dimensions,
    model: process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    provider,
    timeoutMs: normalizePositiveInteger(
      process.env.EMBEDDING_TIMEOUT_MS,
      DEFAULT_EMBEDDING_TIMEOUT_MS,
    ),
  };
}

function normalizeProvider(value, voyageApiKey) {
  if (value === "voyage" || value === "none") {
    return value;
  }

  return voyageApiKey ? "voyage" : "none";
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
