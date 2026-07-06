import { getEmbeddingRuntimeConfig } from "./config.mjs";

export class EmbeddingProviderError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "EmbeddingProviderError";
    this.code = options.code ?? "embedding_provider_error";
    this.statusCode = options.statusCode ?? 500;
  }
}

export async function embedTexts({ inputType = "document", signal, texts }) {
  const config = getEmbeddingRuntimeConfig();

  if (!config.configured) {
    throw new EmbeddingProviderError("Embedding provider is not configured.", {
      code: "embedding_not_configured",
      statusCode: 503,
    });
  }

  if (!Array.isArray(texts) || texts.length === 0) {
    return {
      dimensions: config.dimensions,
      model: config.model,
      usage: { totalTokens: 0 },
      vectors: [],
    };
  }

  if (config.provider !== "voyage") {
    throw new EmbeddingProviderError(`Unsupported embedding provider: ${config.provider}.`, {
      code: "embedding_provider_unsupported",
      statusCode: 503,
    });
  }

  const response = await fetchWithTimeout(`${config.apiBaseUrl}/v1/embeddings`, {
    body: JSON.stringify({
      input: texts,
      input_type: inputType,
      model: config.model,
      output_dimension: config.dimensions,
      output_dtype: "float",
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
    throw toEmbeddingProviderError(response, payload);
  }

  const vectors = normalizeEmbeddingVectors(payload);
  assertVectorDimensions(vectors, config.dimensions);

  return {
    dimensions: config.dimensions,
    model: typeof payload?.model === "string" ? payload.model : config.model,
    usage: normalizeUsage(payload?.usage),
    vectors,
  };
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
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new EmbeddingProviderError("Embedding request timed out or was aborted.", {
        code: "embedding_request_aborted",
        statusCode: 504,
      });
    }

    throw error;
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

function normalizeEmbeddingVectors(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data
      .slice()
      .sort((left, right) => normalizeIndex(left?.index) - normalizeIndex(right?.index))
      .map((item) => item?.embedding)
      .filter(Array.isArray);
  }

  if (Array.isArray(payload?.embeddings)) {
    return payload.embeddings.filter(Array.isArray);
  }

  return [];
}

function normalizeIndex(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assertVectorDimensions(vectors, dimensions) {
  const invalidVector = vectors.find((vector) => vector.length !== dimensions);

  if (invalidVector) {
    throw new EmbeddingProviderError(
      `Embedding dimension mismatch: expected ${dimensions}, got ${invalidVector.length}.`,
      {
        code: "embedding_dimensions_mismatch",
        statusCode: 502,
      },
    );
  }
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  return {
    totalTokens: normalizeNumber(value.total_tokens ?? value.totalTokens),
  };
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toEmbeddingProviderError(response, payload) {
  const message =
    getPayloadErrorMessage(payload) ||
    response.statusText ||
    "Embedding request failed.";

  return new EmbeddingProviderError(message, {
    code: getPayloadErrorCode(payload),
    statusCode: response.status,
  });
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

function getPayloadErrorCode(payload) {
  if (typeof payload?.error?.code === "string") {
    return payload.error.code;
  }

  if (typeof payload?.code === "string") {
    return payload.code;
  }

  return "embedding_provider_error";
}
