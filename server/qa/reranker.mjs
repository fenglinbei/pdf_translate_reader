const DEFAULT_VOYAGE_API_BASE_URL = "https://api.voyageai.com";
const DEFAULT_RERANK_MODEL = "rerank-2.5";
const DEFAULT_CANDIDATE_LIMIT = 50;
const DEFAULT_TOP_K = 12;
const DEFAULT_TIMEOUT_MS = 60000;

export function getRerankerRuntimeConfig() {
  const provider = normalizeProvider(process.env.QA_RERANK_PROVIDER, process.env.VOYAGE_API_KEY);

  return {
    apiBaseUrl: process.env.VOYAGE_API_BASE_URL ?? DEFAULT_VOYAGE_API_BASE_URL,
    apiKey: process.env.VOYAGE_API_KEY,
    candidateLimit: normalizePositiveInteger(
      process.env.QA_RERANK_CANDIDATE_LIMIT,
      DEFAULT_CANDIDATE_LIMIT,
    ),
    configured: provider === "voyage" && Boolean(process.env.VOYAGE_API_KEY),
    model: process.env.QA_RERANK_MODEL || DEFAULT_RERANK_MODEL,
    provider,
    timeoutMs: normalizePositiveInteger(process.env.QA_RERANK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    topK: normalizePositiveInteger(process.env.QA_RERANK_TOP_K, DEFAULT_TOP_K),
  };
}

export async function rerankEvidence({ evidence, question, signal }) {
  const config = getRerankerRuntimeConfig();

  if (!config.configured || evidence.length === 0) {
    return {
      diagnostics: {
        configured: config.configured,
        provider: config.provider,
        skippedReason: config.configured ? "no_candidates" : "reranker_not_configured",
      },
      evidence: evidence.slice(0, config.topK),
      usage: undefined,
      warnings: config.configured ? [] : ["Rerank is not configured; using hybrid retrieval order."],
    };
  }

  if (config.provider !== "voyage") {
    return {
      diagnostics: {
        configured: false,
        provider: config.provider,
        skippedReason: "reranker_provider_unsupported",
      },
      evidence: evidence.slice(0, config.topK),
      usage: undefined,
      warnings: [`Unsupported reranker provider: ${config.provider}. Using hybrid retrieval order.`],
    };
  }

  try {
    const response = await fetchWithTimeout(`${config.apiBaseUrl}/v1/rerank`, {
      body: JSON.stringify({
        documents: evidence.map((item) => formatRerankDocument(item)),
        model: config.model,
        query: question,
        top_k: Math.min(config.topK, evidence.length),
      }),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
      timeoutMs: config.timeoutMs,
    });
    const payload = await readJsonPayload(response);

    if (!response.ok) {
      throw new RerankerProviderError(getPayloadErrorMessage(payload) || response.statusText);
    }

    const rankedEvidence = normalizeRerankResults(payload)
      .map((result) => {
        const item = evidence[result.index];

        if (!item) {
          return undefined;
        }

        return {
          ...item,
          score: result.relevanceScore,
          scoreBreakdown: {
            ...item.scoreBreakdown,
            rerank: result.relevanceScore,
          },
        };
      })
      .filter(Boolean);
    const fallbackEvidence = evidence
      .filter((item) => !rankedEvidence.some((ranked) => ranked.chunkId === item.chunkId))
      .slice(0, Math.max(0, config.topK - rankedEvidence.length));

    return {
      diagnostics: {
        candidateCount: evidence.length,
        configured: true,
        model: config.model,
        provider: config.provider,
        topK: Math.min(config.topK, evidence.length),
      },
      evidence: [...rankedEvidence, ...fallbackEvidence].slice(0, config.topK)
        .map((item, index) => ({
          ...item,
          evidenceId: `C${index + 1}`,
        })),
      usage: normalizeUsage(payload?.usage),
      warnings: [],
    };
  } catch (error) {
    return {
      diagnostics: {
        candidateCount: evidence.length,
        configured: true,
        errorMessage: error instanceof Error ? error.message : "Rerank failed.",
        model: config.model,
        provider: config.provider,
        skippedReason: "reranker_failed",
      },
      evidence: evidence.slice(0, config.topK),
      usage: undefined,
      warnings: [
        error instanceof Error
          ? `Rerank failed; using hybrid retrieval order. ${error.message}`
          : "Rerank failed; using hybrid retrieval order.",
      ],
    };
  }
}

export class RerankerProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = "RerankerProviderError";
  }
}

function formatRerankDocument(item) {
  return [
    item.documentTitle ? `Document: ${item.documentTitle}` : "",
    `Pages: ${item.pageStart}${item.pageEnd !== item.pageStart ? `-${item.pageEnd}` : ""}`,
    Array.isArray(item.sectionPath) && item.sectionPath.length > 0
      ? `Section: ${item.sectionPath.join(" / ")}`
      : "",
    item.text ?? item.textPreview ?? "",
  ].filter(Boolean).join("\n");
}

async function fetchWithTimeout(url, options) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  const abortListener = () => timeoutController.abort();

  options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    return await fetch(url, {
      body: options.body,
      headers: options.headers,
      method: options.method,
      signal: timeoutController.signal,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
}

async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeRerankResults(payload) {
  const candidates = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.results)
      ? payload.results
      : [];

  return candidates
    .map((item) => ({
      index: normalizeIndex(item?.index),
      relevanceScore: normalizeNumber(
        item?.relevance_score ?? item?.relevanceScore ?? item?.score,
      ),
    }))
    .filter((item) => Number.isInteger(item.index))
    .sort((left, right) => right.relevanceScore - left.relevanceScore);
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return {
    totalTokens: normalizeNumber(value.total_tokens ?? value.totalTokens),
  };
}

function getPayloadErrorMessage(payload) {
  if (typeof payload?.error === "string") {
    return payload.error;
  }

  if (typeof payload?.error?.message === "string") {
    return payload.error.message;
  }

  if (typeof payload?.message === "string") {
    return payload.message;
  }

  return undefined;
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

function normalizeIndex(value) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeNumber(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}
