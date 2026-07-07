import { createQaChunks } from "./chunker.mjs";
import { QA_CHUNKER_VERSION } from "./config.mjs";
import { loadMathpixStructuredDocument } from "./documentParser.mjs";
import { embedTexts } from "../embedding/client.mjs";
import { getEmbeddingRuntimeConfig } from "../embedding/config.mjs";
import { requireSupabaseServiceClient } from "../supabase/service.mjs";

export const QA_INDEX_ACTIVE_STATUSES = [
  "pending",
  "extracting",
  "chunking",
  "embedding",
  "reference-matching",
];

const QA_INDEX_JOB_COLUMNS = [
  "chunker_version",
  "content_sha256",
  "created_at",
  "deleted_at",
  "embedding_dimensions",
  "embedding_model",
  "error_message",
  "finished_at",
  "id",
  "payload",
  "pdf_fingerprint",
  "progress_percent",
  "reference_matcher_version",
  "retriever_version",
  "source",
  "started_at",
  "status",
  "updated_at",
  "user_document_id",
  "user_id",
].join(",");

const activeStatusSet = new Set(QA_INDEX_ACTIVE_STATUSES);
const queuedJobIds = new Set();
const queue = [];

let isDrainingQueue = false;

export function isActiveQaIndexJobStatus(status) {
  return activeStatusSet.has(status);
}

export function enqueueQaIndexJob(job) {
  if (!job?.id || queuedJobIds.has(job.id)) {
    return job;
  }

  queuedJobIds.add(job.id);
  queue.push(job.id);
  void drainQueue();

  return job;
}

export async function recoverQaIndexJobs() {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select("id")
    .in("status", QA_INDEX_ACTIVE_STATUSES)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message || "Could not recover QA index jobs.");
  }

  for (const row of data ?? []) {
    enqueueQaIndexJob({ id: row.id });
  }
}

async function drainQueue() {
  if (isDrainingQueue) {
    return;
  }

  isDrainingQueue = true;

  try {
    while (queue.length > 0) {
      const jobId = queue.shift();

      if (!jobId) {
        continue;
      }

      try {
        await runQaIndexJob(jobId);
      } catch (error) {
        console.error("QA index job failed", jobId, error);
      } finally {
        queuedJobIds.delete(jobId);
      }
    }
  } finally {
    isDrainingQueue = false;
  }
}

async function runQaIndexJob(jobId) {
  const job = await getQaIndexJobRow(jobId);

  if (!job || !isActiveQaIndexJobStatus(job.status)) {
    return;
  }

  if (job.source !== "mathpix-v3-pdf") {
    await failJob(job, "PDF text indexing is not supported yet.");
    return;
  }

  try {
    await updateJob(job.id, {
      error_message: null,
      progress_percent: 10,
      started_at: job.started_at ?? new Date().toISOString(),
      status: "extracting",
    });

    const document = await loadMathpixStructuredDocument({ job });

    await updateJob(job.id, {
      payload: mergePayload(job.payload, {
        pageCount: document.pageCount,
        referencesStartPage: document.referencesStartPage,
        title: document.title,
      }),
      progress_percent: 35,
      status: "chunking",
    });

    const chunks = createQaChunks({
      chunkerVersion: job.chunker_version || QA_CHUNKER_VERSION,
      document,
      source: job.source,
    });

    if (chunks.length === 0) {
      throw new Error("Could not create QA chunks from the MathPix document.");
    }

    await updateJob(job.id, {
      payload: mergePayload(job.payload, {
        chunkCount: chunks.length,
        pageCount: document.pageCount,
        referencesStartPage: document.referencesStartPage,
        title: document.title,
      }),
      progress_percent: 55,
      status: "embedding",
    });

    const embeddingResult = await tryEmbedChunks({
      chunks,
      onProgress: async (progressPercent) => {
        await updateJob(job.id, { progress_percent: progressPercent });
      },
    });

    await replaceDocumentChunks({
      chunks,
      embeddingResult,
      job,
    });

    const finishedAt = new Date().toISOString();
    const finalPayload = mergePayload(job.payload, {
      chunkCount: chunks.length,
      embedding: {
        dimensions: embeddingResult.dimensions,
        model: embeddingResult.model,
        provider: embeddingResult.provider,
        usage: embeddingResult.usage,
      },
      pageCount: document.pageCount,
      referencesStartPage: document.referencesStartPage,
      title: document.title,
    });

    await updateJob(job.id, {
      embedding_dimensions: embeddingResult.dimensions,
      embedding_model: embeddingResult.model,
      finished_at: finishedAt,
      payload: finalPayload,
      progress_percent: 100,
      status: "ready",
    });
  } catch (error) {
    await failJob(job, error instanceof Error ? error.message : "QA index job failed.");
  }
}

async function tryEmbedChunks({ chunks, onProgress }) {
  const config = getEmbeddingRuntimeConfig();

  if (!config.configured) {
    throw new Error(
      "Embedding provider is not configured. Set VOYAGE_API_KEY to build a QA index with semantic search.",
    );
  }

  const vectors = [];
  let totalTokens = 0;

  for (let start = 0; start < chunks.length; start += config.batchSize) {
    const batch = chunks.slice(start, start + config.batchSize);
    const result = await embedBatchWithRetry(batch.map((chunk) => chunk.text));

    vectors.push(...result.vectors);
    totalTokens += result.usage?.totalTokens ?? 0;

    const completed = Math.min(chunks.length, start + batch.length);
    await onProgress(55 + Math.round((completed / chunks.length) * 35));
  }

  if (vectors.length !== chunks.length) {
    throw new Error("Embedding provider returned an unexpected number of vectors.");
  }

  return {
    dimensions: config.dimensions,
    model: config.model,
    provider: config.provider,
    usage: totalTokens > 0 ? { totalTokens } : undefined,
    vectors,
  };
}

async function embedBatchWithRetry(texts) {
  let lastError;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await embedTexts({ inputType: "document", texts });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function replaceDocumentChunks({ chunks, embeddingResult, job }) {
  const client = requireSupabaseServiceClient();
  const now = new Date().toISOString();

  const { error: deleteError } = await client
    .from("user_paper_chunks")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_id", job.user_id)
    .eq("user_document_id", job.user_document_id)
    .eq("chunker_version", job.chunker_version)
    .is("deleted_at", null);

  if (deleteError) {
    throw new Error(deleteError.message || "Could not replace old QA chunks.");
  }

  const rows = chunks.map((chunk, index) => ({
    chunk_hash: chunk.chunkHash,
    chunk_index: chunk.chunkIndex,
    chunker_version: job.chunker_version,
    content_sha256: job.content_sha256,
    embedding: embeddingResult.vectors?.[index]
      ? formatVector(embeddingResult.vectors[index])
      : null,
    embedding_dimensions: embeddingResult.vectors?.[index]
      ? embeddingResult.dimensions
      : null,
    embedding_model: embeddingResult.vectors?.[index]
      ? embeddingResult.model
      : null,
    mmd: chunk.mmd,
    page_end: chunk.pageEnd,
    page_start: chunk.pageStart,
    pdf_fingerprint: job.pdf_fingerprint,
    section_path: chunk.sectionPath ?? null,
    source: job.source,
    text: chunk.text,
    title: chunk.title ?? null,
    token_count: chunk.tokenCount,
    updated_at: now,
    user_document_id: job.user_document_id,
    user_id: job.user_id,
  }));

  const { error: insertError } = await client
    .from("user_paper_chunks")
    .insert(rows);

  if (insertError) {
    throw new Error(insertError.message || "Could not write QA chunks.");
  }
}

async function getQaIndexJobRow(jobId) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select(QA_INDEX_JOB_COLUMNS)
    .eq("id", jobId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Could not read QA index job.");
  }

  return data;
}

async function updateJob(jobId, patch) {
  const { error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (error) {
    throw new Error(error.message || "Could not update QA index job.");
  }
}

async function failJob(job, message) {
  await updateJob(job.id, {
    error_message: message,
    finished_at: new Date().toISOString(),
    progress_percent: 100,
    status: "error",
  });
}

function mergePayload(currentPayload, patch) {
  return {
    ...(isRecord(currentPayload) ? currentPayload : {}),
    ...patch,
  };
}

function formatVector(vector) {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
