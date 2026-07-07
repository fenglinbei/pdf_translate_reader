import { embedTexts } from "../embedding/client.mjs";
import { getEmbeddingRuntimeConfig } from "../embedding/config.mjs";
import { SupabaseServiceError, requireSupabaseServiceClient } from "../supabase/service.mjs";
import { getLatestQaIndexJob } from "../supabase/qa.mjs";
import { QA_CHUNKER_VERSION, QA_LONG_CONTEXT_MAX_CHARS, QA_RETRIEVER_VERSION } from "./config.mjs";
import { computeAnswerContextBudget } from "./contextBudget.mjs";
import { loadMathpixStructuredDocument } from "./documentParser.mjs";
import {
  getRerankerRuntimeConfig,
  rerankEvidence,
} from "./reranker.mjs";

const DEFAULT_MATCH_COUNT = 12;
const MAX_QUERY_CHARS = 2000;
const MAX_TEXT_PREVIEW_CHARS = 520;

export async function retrieveCurrentPaperEvidence({
  matchCount,
  question,
  signal,
  userDocumentId,
  userId,
}) {
  const normalizedQuestion = normalizeQuestion(question);
  const indexJob = await requireUsableIndexJob({ userDocumentId, userId });
  const rerankerConfig = getRerankerRuntimeConfig();
  const queryEmbedding = await createQueryEmbedding({
    indexJob,
    question: normalizedQuestion,
  });
  const rows = await matchChunks({
    embedding: queryEmbedding.vector,
    embeddingDimensions: queryEmbedding.dimensions,
    embeddingModel: queryEmbedding.model,
    matchCount: normalizePositiveInteger(
      matchCount,
      rerankerConfig.configured ? rerankerConfig.candidateLimit : DEFAULT_MATCH_COUNT,
    ),
    question: normalizedQuestion,
    userDocumentId,
    userId,
  });
  const hybridEvidence = rows.map((row, index) => rowToEvidence(row, index));
  const rerankResult = await rerankEvidence({
    evidence: hybridEvidence,
    question: normalizedQuestion,
    signal,
  });

  return {
    diagnostics: {
      candidateCount: hybridEvidence.length,
      embedding: {
        dimensions: queryEmbedding.dimensions,
        model: queryEmbedding.model,
        used: Boolean(queryEmbedding.vector),
      },
      rerank: rerankResult.diagnostics,
    },
    evidence: rerankResult.evidence,
    queryPlan: createQueryPlan(normalizedQuestion),
    rerankerUsage: rerankResult.usage,
    rerankerVersion: rerankResult.diagnostics?.model,
    retrieverVersion: QA_RETRIEVER_VERSION,
    warnings: [...rerankResult.warnings],
  };
}

export function createQueryPlan(question) {
  const lowerQuestion = String(question ?? "").toLocaleLowerCase();
  const isComparison = /\b(compare|difference|versus|vs\.?|对比|比较|区别)\b/.test(lowerQuestion);
  const isSummary = /\b(summary|summarize|overview|总结|概括)\b/.test(lowerQuestion);
  const isResult = /\b(result|experiment|accuracy|性能|结果|实验)\b/.test(lowerQuestion);
  const isMethod = /\b(method|approach|algorithm|模型|方法|算法)\b/.test(lowerQuestion);
  const intent = isComparison
    ? "comparison"
    : isSummary
      ? "summary"
      : isResult
        ? "result"
        : isMethod
          ? "method"
          : "question";

  return {
    answerFormat: isComparison ? "table" : isSummary ? "bullets" : "paragraph",
    intent,
    requiredEvidence: isComparison ? "comparison" : isSummary ? "multi" : "single",
    rewrittenQueries: [normalizeQuestion(question)],
  };
}

async function requireUsableIndexJob({ userDocumentId, userId }) {
  const job = await getLatestQaIndexJob({ userDocumentId, userId });

  if (!job) {
    throw new SupabaseServiceError(
      409,
      "qa_index_not_built",
      "Build the QA index before asking questions.",
    );
  }

  if (job.status !== "ready") {
    throw new SupabaseServiceError(
      409,
      "qa_index_not_ready",
      job.status === "ready_degraded"
        ? "The QA index is incomplete (semantic search unavailable). Rebuild the index to enable semantic retrieval."
        : "The QA index is not ready yet.",
    );
  }

  if (job.chunkerVersion && job.chunkerVersion !== QA_CHUNKER_VERSION) {
    throw new SupabaseServiceError(
      409,
      "qa_index_outdated",
      "The QA index was built with an older chunker and is missing LaTeX formula data. Rebuild the index to enable formula-aware answers.",
    );
  }

  return job;
}

async function createQueryEmbedding({ indexJob, question }) {
  if (
    indexJob.status !== "ready" ||
    !indexJob.embeddingModel ||
    indexJob.embeddingModel === "none" ||
    !indexJob.embeddingDimensions
  ) {
    throw new SupabaseServiceError(
      503,
      "embedding_unavailable",
      "Semantic retrieval is unavailable for this index. Rebuild the index with embeddings enabled.",
    );
  }

  const config = getEmbeddingRuntimeConfig();

  if (!config.configured) {
    throw new SupabaseServiceError(
      503,
      "embedding_not_configured",
      "Embedding provider is not configured. Set VOYAGE_API_KEY to enable semantic retrieval.",
    );
  }

  const result = await embedTexts({
    inputType: "query",
    texts: [question],
  });

  return {
    dimensions: result.dimensions,
    model: result.model,
    vector: result.vectors[0],
  };
}

async function matchChunks({
  embedding,
  embeddingDimensions,
  embeddingModel,
  matchCount,
  question,
  userDocumentId,
  userId,
}) {
  const { data, error } = await requireSupabaseServiceClient().rpc(
    "match_user_paper_chunks_current",
    {
      p_embedding_dimensions: embeddingDimensions ?? null,
      p_embedding_model: embeddingModel ?? null,
      p_match_count: matchCount ?? DEFAULT_MATCH_COUNT,
      p_query_embedding: embedding ? formatVector(embedding) : null,
      p_query_text: question,
      p_user_document_id: userDocumentId,
      p_user_id: userId,
    },
  );

  if (error) {
    throw new SupabaseServiceError(
      500,
      "qa_retrieval_failed",
      error.message || "Could not retrieve QA evidence.",
    );
  }

  return Array.isArray(data) ? data : [];
}

function rowToEvidence(row, index) {
  const text = cleanText(row.text);

  return {
    chunkId: row.chunk_id,
    cloudDocumentId: row.user_document_id,
    documentTitle: cleanText(row.document_title) || cleanText(row.title) || "Current paper",
    evidenceId: `C${index + 1}`,
    mmd: row.mmd ? cleanText(row.mmd) : undefined,
    pageEnd: normalizePositiveInteger(row.page_end, 1),
    pageStart: normalizePositiveInteger(row.page_start, 1),
    pdfFingerprint: cleanText(row.pdf_fingerprint),
    score: normalizeNumber(row.score),
    scoreBreakdown: {
      fullText: normalizeNumber(row.full_text_score),
      metadataBoost: normalizeNumber(row.metadata_boost),
      vector: normalizeNumber(row.vector_score),
    },
    sectionPath: Array.isArray(row.section_path) ? row.section_path.filter(Boolean) : undefined,
    text,
    textPreview: truncateText(text, MAX_TEXT_PREVIEW_CHARS),
  };
}

export async function loadCurrentPaperFullText({ userDocumentId, userId, model }) {
  const job = await requireUsableIndexJob({ userDocumentId, userId });
  const document = await loadMathpixStructuredDocument({ job });

  const rawText = document.fullMmd
    ? document.fullMmd
    : (document.pages ?? [])
        .map((page) => page.pageText)
        .filter(Boolean)
        .join("\n\n");

  if (!rawText.trim()) {
    throw new SupabaseServiceError(
      502,
      "long_context_unavailable",
      "Could not load the paper full text for long-context answering.",
    );
  }

  const budget = computeAnswerContextBudget({ model, mode: "long_context" });
  const { text, truncated } = truncateForLongContext(rawText, budget.fullPaperTextChars);

  return {
    estimatedTokens: Math.round(text.length / 3.5),
    text,
    title: document.title,
    truncated,
  };
}

function truncateForLongContext(text, maxChars) {
  const ceiling = maxChars && maxChars > 0 ? maxChars : QA_LONG_CONTEXT_MAX_CHARS;

  if (text.length <= ceiling) {
    return { text, truncated: false };
  }

  const headLength = Math.round(ceiling * 0.7);
  const tailLength = Math.max(0, ceiling - headLength - 40);
  const head = text.slice(0, headLength);
  const tail = text.slice(Math.max(headLength, text.length - tailLength));

  return {
    text: `${head}\n\n[... content truncated ...]\n\n${tail}`,
    truncated: true,
  };
}

function normalizeQuestion(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

function formatVector(vector) {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function normalizeNumber(value) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function truncateText(value, maxCharacters) {
  const text = cleanText(value);

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, maxCharacters - 3).trim()}...`;
}
