import { randomUUID } from "node:crypto";
import {
  QA_CHUNKER_VERSION,
  QA_REFERENCE_MATCHER_VERSION,
  QA_RETRIEVER_VERSION,
} from "../qa/config.mjs";
import { getEmbeddingRuntimeConfig } from "../embedding/config.mjs";
import {
  QA_INDEX_ACTIVE_STATUSES,
  enqueueQaIndexJob,
} from "../qa/indexJobRunner.mjs";
import {
  requireSupabaseServiceClient,
  SupabaseServiceError,
} from "./service.mjs";

const DUPLICATE_KEY_ERROR_CODE = "23505";

const USER_DOCUMENT_COLUMNS = [
  "content_sha256",
  "display_file_name",
  "id",
  "pdf_fingerprint",
  "user_id",
].join(",");

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

const QA_THREAD_COLUMNS = [
  "active_user_document_id",
  "created_at",
  "deleted_at",
  "id",
  "reference_document_ids",
  "scope",
  "title",
  "updated_at",
  "user_id",
].join(",");

const QA_MESSAGE_COLUMNS = [
  "content",
  "created_at",
  "deleted_at",
  "error_message",
  "id",
  "model",
  "prompt_version",
  "retrieval_snapshot",
  "role",
  "status",
  "thread_id",
  "updated_at",
  "usage",
  "user_id",
].join(",");

const QA_CITATION_COLUMNS = [
  "chunk_id",
  "confidence",
  "created_at",
  "deleted_at",
  "document_title",
  "id",
  "message_id",
  "page_end",
  "page_start",
  "pdf_fingerprint",
  "quoted_text",
  "section_path",
  "user_document_id",
  "user_id",
].join(",");

const QA_AGENT_STEP_COLUMNS = [
  "created_at",
  "deleted_at",
  "evidence_ids",
  "id",
  "kind",
  "message_id",
  "payload",
  "status",
  "step_index",
  "summary",
  "tool_name",
  "user_id",
].join(",");

const QA_TOOL_CALL_COLUMNS = [
  "created_at",
  "deleted_at",
  "error_message",
  "finished_at",
  "id",
  "input",
  "output_summary",
  "result_evidence_ids",
  "started_at",
  "status",
  "step_id",
  "tool_name",
  "user_id",
].join(",");

const QA_API_LOG_COLUMNS = [
  "created_at",
  "deleted_at",
  "error_message",
  "id",
  "message_id",
  "model",
  "payload",
  "pdf_fingerprint",
  "prompt_version",
  "request_finished_at",
  "request_kind",
  "request_started_at",
  "retriever_version",
  "status",
  "thread_id",
  "usage",
  "user_document_id",
  "user_id",
].join(",");

export async function getLatestQaIndexJob({ userDocumentId, userId }) {
  await requireUserDocument({ userDocumentId, userId });

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select(QA_INDEX_JOB_COLUMNS)
    .eq("user_id", userId)
    .eq("user_document_id", userDocumentId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_index_job_query_failed", "Could not read QA index job.");
  }

  return data ? rowToQaIndexJob(data) : undefined;
}

export async function listQaThreadsForDocument({ userDocumentId, userId }) {
  await requireUserDocument({ userDocumentId, userId });

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_threads")
    .select(QA_THREAD_COLUMNS)
    .eq("user_id", userId)
    .eq("active_user_document_id", userDocumentId)
    .eq("scope", "current")
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(30);

  if (error) {
    throw toSupabaseServiceError(error, "qa_threads_query_failed", "Could not read QA threads.");
  }

  return (data ?? []).map(rowToQaThread);
}

export async function listQaMessagesForThread({ threadId, userId }) {
  await requireQaThread({ threadId, userId });

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .select(QA_MESSAGE_COLUMNS)
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw toSupabaseServiceError(error, "qa_messages_query_failed", "Could not read QA messages.");
  }

  const messages = (data ?? []).map(rowToQaMessage);
  const messageIds = messages.map((message) => message.id);

  if (messageIds.length === 0) {
    return [];
  }

  const { data: citationRows, error: citationError } = await requireSupabaseServiceClient()
    .from("user_qa_citations")
    .select(QA_CITATION_COLUMNS)
    .eq("user_id", userId)
    .in("message_id", messageIds)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (citationError) {
    throw toSupabaseServiceError(
      citationError,
      "qa_citations_query_failed",
      "Could not read QA citations.",
    );
  }

  const citationsByMessageId = new Map();

  for (const citation of (citationRows ?? []).map(rowToQaCitation)) {
    const citations = citationsByMessageId.get(citation.messageId) ?? [];
    citations.push(citation);
    citationsByMessageId.set(citation.messageId, citations);
  }

  const steps = await listQaAgentStepsForMessages({
    messageIds,
    userId,
  });
  const stepsByMessageId = new Map();

  for (const step of steps) {
    const messageSteps = stepsByMessageId.get(step.messageId) ?? [];
    messageSteps.push(step);
    stepsByMessageId.set(step.messageId, messageSteps);
  }

  return messages.map((message) => ({
    ...message,
    agentSteps: stepsByMessageId.get(message.id) ?? [],
    citations: citationsByMessageId.get(message.id) ?? [],
  }));
}

export async function deleteQaThread({ threadId, userId }) {
  await requireQaThread({ threadId, userId });

  const now = new Date().toISOString();
  const { data: messageRows, error: messageQueryError } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .select("id")
    .eq("user_id", userId)
    .eq("thread_id", threadId)
    .is("deleted_at", null);

  if (messageQueryError) {
    throw toSupabaseServiceError(
      messageQueryError,
      "qa_thread_messages_query_failed",
      "Could not read QA thread messages before deletion.",
    );
  }

  const messageIds = (messageRows ?? []).map((row) => row.id).filter(Boolean);

  if (messageIds.length > 0) {
    const { data: stepRows, error: stepQueryError } = await requireSupabaseServiceClient()
      .from("user_qa_agent_steps")
      .select("id")
      .eq("user_id", userId)
      .in("message_id", messageIds)
      .is("deleted_at", null);

    if (stepQueryError) {
      throw toSupabaseServiceError(
        stepQueryError,
        "qa_thread_agent_steps_query_failed",
        "Could not read QA agent steps before deletion.",
      );
    }

    const stepIds = (stepRows ?? []).map((row) => row.id).filter(Boolean);

    if (stepIds.length > 0) {
      await softDeleteRows({
        code: "qa_thread_tool_calls_delete_failed",
        filter: (query) => query.in("step_id", stepIds),
        table: "user_qa_tool_calls",
        userId,
        when: now,
      });
    }

    await softDeleteRows({
      code: "qa_thread_agent_steps_delete_failed",
      filter: (query) => query.in("message_id", messageIds),
      table: "user_qa_agent_steps",
      userId,
      when: now,
    });
    await softDeleteRows({
      code: "qa_thread_citations_delete_failed",
      filter: (query) => query.in("message_id", messageIds),
      table: "user_qa_citations",
      userId,
      when: now,
    });
    await softDeleteRows({
      code: "qa_thread_messages_delete_failed",
      filter: (query) => query.eq("thread_id", threadId),
      table: "user_qa_messages",
      userId,
      when: now,
    });
  }

  await softDeleteRows({
    code: "qa_thread_logs_delete_failed",
    filter: (query) => query.eq("thread_id", threadId),
    table: "user_qa_api_logs",
    userId,
    when: now,
  });

  const { error } = await requireSupabaseServiceClient()
    .from("user_qa_threads")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("id", threadId)
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (error) {
    throw toSupabaseServiceError(error, "qa_thread_delete_failed", "Could not delete QA thread.");
  }

  return {
    deletedAt: Date.parse(now),
    threadId,
  };
}

/**
 * Soft-delete a single QA message and its cascade (tool calls, agent steps,
 * citations, api logs). Used by message-level delete and regenerate flows.
 */
export async function deleteQaMessage({ messageId, userId }) {
  const now = new Date().toISOString();

  // Verify ownership via the message's thread.
  const { data: messageRow, error: messageQueryError } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .select("id, thread_id")
    .eq("id", messageId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (messageQueryError) {
    throw toSupabaseServiceError(
      messageQueryError,
      "qa_message_query_failed",
      "Could not read QA message before deletion.",
    );
  }

  if (!messageRow) {
    throw new SupabaseServiceError(
      404,
      "qa_message_not_found",
      "QA message was not found for this user.",
    );
  }

  const { data: stepRows, error: stepQueryError } = await requireSupabaseServiceClient()
    .from("user_qa_agent_steps")
    .select("id")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .is("deleted_at", null);

  if (stepQueryError) {
    throw toSupabaseServiceError(
      stepQueryError,
      "qa_message_agent_steps_query_failed",
      "Could not read QA agent steps before deletion.",
    );
  }

  const stepIds = (stepRows ?? []).map((row) => row.id).filter(Boolean);

  if (stepIds.length > 0) {
    await softDeleteRows({
      code: "qa_message_tool_calls_delete_failed",
      filter: (query) => query.in("step_id", stepIds),
      table: "user_qa_tool_calls",
      userId,
      when: now,
    });
  }

  await softDeleteRows({
    code: "qa_message_agent_steps_delete_failed",
    filter: (query) => query.eq("message_id", messageId),
    table: "user_qa_agent_steps",
    userId,
    when: now,
  });
  await softDeleteRows({
    code: "qa_message_citations_delete_failed",
    filter: (query) => query.eq("message_id", messageId),
    table: "user_qa_citations",
    userId,
    when: now,
  });
  await softDeleteRows({
    code: "qa_message_logs_delete_failed",
    filter: (query) => query.eq("message_id", messageId),
    table: "user_qa_api_logs",
    userId,
    when: now,
  });

  const { error } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .update({ deleted_at: now })
    .eq("id", messageId)
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (error) {
    throw toSupabaseServiceError(error, "qa_message_delete_failed", "Could not delete QA message.");
  }

  return {
    deletedAt: Date.parse(now),
    messageId,
  };
}

export async function createOrReuseQaThread({
  activeUserDocumentId,
  question,
  threadId,
  userId,
}) {
  await requireUserDocument({ userDocumentId: activeUserDocumentId, userId });

  if (threadId) {
    const thread = await requireQaThread({ threadId, userId });

    if (thread.scope !== "current") {
      throw new SupabaseServiceError(
        409,
        "qa_thread_scope_unsupported",
        "Only current-paper QA threads are supported in this milestone.",
      );
    }

    if (thread.activeCloudDocumentId && thread.activeCloudDocumentId !== activeUserDocumentId) {
      throw new SupabaseServiceError(
        409,
        "qa_thread_document_mismatch",
        "This QA thread belongs to a different document.",
      );
    }

    return touchQaThread({ threadId, userId });
  }

  const now = new Date().toISOString();
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_threads")
    .insert({
      active_user_document_id: activeUserDocumentId,
      reference_document_ids: [],
      scope: "current",
      title: createThreadTitle(question),
      updated_at: now,
      user_id: userId,
    })
    .select(QA_THREAD_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(error, "qa_thread_create_failed", "Could not create QA thread.");
  }

  return rowToQaThread(data);
}

export async function insertQaMessage({
  content,
  errorMessage,
  model,
  promptVersion,
  retrievalSnapshot,
  role,
  status,
  threadId,
  usage,
  userId,
}) {
  const now = new Date().toISOString();
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .insert({
      content,
      error_message: errorMessage ?? null,
      model: model ?? null,
      prompt_version: promptVersion ?? null,
      retrieval_snapshot: retrievalSnapshot ?? null,
      role,
      status,
      thread_id: threadId,
      updated_at: now,
      usage: usage ?? null,
      user_id: userId,
    })
    .select(QA_MESSAGE_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(error, "qa_message_create_failed", "Could not create QA message.");
  }

  return rowToQaMessage(data);
}

export async function updateQaMessage({
  content,
  errorMessage,
  messageId,
  retrievalSnapshot,
  status,
  usage,
  userId,
}) {
  const patch = {
    updated_at: new Date().toISOString(),
  };

  if (content !== undefined) {
    patch.content = content;
  }

  if (errorMessage !== undefined) {
    patch.error_message = errorMessage;
  }

  if (retrievalSnapshot !== undefined) {
    patch.retrieval_snapshot = retrievalSnapshot;
  }

  if (status !== undefined) {
    patch.status = status;
  }

  if (usage !== undefined) {
    patch.usage = usage;
  }

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_messages")
    .update(patch)
    .eq("id", messageId)
    .eq("user_id", userId)
    .select(QA_MESSAGE_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(error, "qa_message_update_failed", "Could not update QA message.");
  }

  return rowToQaMessage(data);
}

export async function insertQaCitations({ citations, messageId, userId }) {
  if (!Array.isArray(citations) || citations.length === 0) {
    return [];
  }

  const rows = citations.map((citation) => ({
    chunk_id: citation.chunkId,
    confidence: citation.confidence,
    document_title: citation.documentTitle,
    message_id: messageId,
    page_end: citation.pageEnd,
    page_start: citation.pageStart,
    pdf_fingerprint: citation.pdfFingerprint,
    quoted_text: citation.quotedText,
    section_path: citation.sectionPath ?? null,
    user_document_id: citation.cloudDocumentId,
    user_id: userId,
  }));

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_citations")
    .insert(rows)
    .select(QA_CITATION_COLUMNS);

  if (error) {
    throw toSupabaseServiceError(
      error,
      "qa_citation_create_failed",
      "Could not save QA citations.",
    );
  }

  return (data ?? []).map(rowToQaCitation);
}

export async function insertQaAgentStep({
  evidenceIds,
  kind,
  messageId,
  payload,
  status = "success",
  stepIndex,
  summary,
  toolName,
  userId,
}) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_agent_steps")
    .insert({
      evidence_ids: Array.isArray(evidenceIds) ? evidenceIds : [],
      kind,
      message_id: messageId,
      payload: payload ?? null,
      status,
      step_index: stepIndex,
      summary,
      tool_name: toolName ?? null,
      user_id: userId,
    })
    .select(QA_AGENT_STEP_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(
      error,
      "qa_agent_step_create_failed",
      "Could not save QA agent step.",
    );
  }

  return rowToQaAgentStep(data);
}

export async function insertQaToolCall({
  errorMessage,
  finishedAt,
  input,
  outputSummary,
  resultEvidenceIds,
  startedAt,
  status,
  stepId,
  toolName,
  userId,
}) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_tool_calls")
    .insert({
      error_message: errorMessage ?? null,
      finished_at: formatOptionalDate(finishedAt),
      input: input ?? {},
      output_summary: outputSummary ?? null,
      result_evidence_ids: Array.isArray(resultEvidenceIds) ? resultEvidenceIds : [],
      started_at: formatOptionalDate(startedAt) ?? new Date().toISOString(),
      status,
      step_id: stepId,
      tool_name: toolName,
      user_id: userId,
    })
    .select(QA_TOOL_CALL_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(
      error,
      "qa_tool_call_create_failed",
      "Could not save QA tool call.",
    );
  }

  return rowToQaToolCall(data);
}

export async function listQaAgentStepsForMessages({ messageIds, userId }) {
  const ids = Array.isArray(messageIds)
    ? messageIds.filter((id) => typeof id === "string" && id.trim())
    : [];

  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_agent_steps")
    .select(QA_AGENT_STEP_COLUMNS)
    .eq("user_id", userId)
    .in("message_id", ids)
    .is("deleted_at", null)
    .order("step_index", { ascending: true });

  if (error) {
    throw toSupabaseServiceError(
      error,
      "qa_agent_steps_query_failed",
      "Could not read QA agent steps.",
    );
  }

  const steps = (data ?? []).map(rowToQaAgentStep);
  const toolCalls = await listQaToolCallsForSteps({
    stepIds: steps.map((step) => step.id),
    userId,
  });
  const toolCallByStepId = new Map(toolCalls.map((toolCall) => [toolCall.stepId, toolCall]));

  return steps.map((step) => ({
    ...step,
    toolCall: toolCallByStepId.get(step.id),
  }));
}

export async function listQaToolCallsForSteps({ stepIds, userId }) {
  const ids = Array.isArray(stepIds)
    ? stepIds.filter((id) => typeof id === "string" && id.trim())
    : [];

  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_tool_calls")
    .select(QA_TOOL_CALL_COLUMNS)
    .eq("user_id", userId)
    .in("step_id", ids)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    throw toSupabaseServiceError(
      error,
      "qa_tool_calls_query_failed",
      "Could not read QA tool calls.",
    );
  }

  return (data ?? []).map(rowToQaToolCall);
}

export async function insertQaApiLog({
  errorMessage,
  messageId,
  model,
  payload,
  pdfFingerprint,
  promptVersion,
  requestFinishedAt,
  requestKind,
  requestStartedAt,
  retrieverVersion,
  status,
  threadId,
  usage,
  userDocumentId,
  userId,
}) {
  const startedAt = requestStartedAt instanceof Date
    ? requestStartedAt.toISOString()
    : new Date(requestStartedAt ?? Date.now()).toISOString();
  const finishedAt = requestFinishedAt === undefined
    ? new Date().toISOString()
    : requestFinishedAt instanceof Date
      ? requestFinishedAt.toISOString()
      : new Date(requestFinishedAt).toISOString();
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_api_logs")
    .insert({
      error_message: errorMessage ?? null,
      id: randomUUID(),
      message_id: messageId ?? null,
      model: model ?? null,
      payload: payload ?? null,
      pdf_fingerprint: pdfFingerprint ?? null,
      prompt_version: promptVersion ?? null,
      request_finished_at: finishedAt,
      request_kind: requestKind,
      request_started_at: startedAt,
      retriever_version: retrieverVersion ?? null,
      status,
      thread_id: threadId ?? null,
      usage: usage ?? null,
      user_document_id: userDocumentId ?? null,
      user_id: userId,
    })
    .select(QA_API_LOG_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(error, "qa_api_log_create_failed", "Could not write QA API log.");
  }

  return data;
}

export async function createOrUpdateIndexJob({ source, userDocumentId, userId }) {
  const document = await requireUserDocument({ userDocumentId, userId });
  const existingJob = await getActiveQaIndexJob({ userDocumentId, userId });

  if (existingJob) {
    return {
      job: existingJob,
      reused: true,
    };
  }

  const now = new Date().toISOString();
  const embedding = getEmbeddingRuntimeConfig();
  const jobInsert = {
    chunker_version: QA_CHUNKER_VERSION,
    content_sha256: document.content_sha256,
    embedding_dimensions: embedding.configured ? embedding.dimensions : null,
    embedding_model: embedding.configured ? embedding.model : "none",
    pdf_fingerprint: document.pdf_fingerprint,
    progress_percent: 0,
    reference_matcher_version: QA_REFERENCE_MATCHER_VERSION,
    retriever_version: QA_RETRIEVER_VERSION,
    source,
    status: "pending",
    updated_at: now,
    user_document_id: document.id,
    user_id: userId,
    payload: {
      displayFileName: document.display_file_name,
      embeddingProvider: embedding.provider,
      source,
    },
  };

  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .insert(jobInsert)
    .select(QA_INDEX_JOB_COLUMNS)
    .single();

  if (error) {
    if (getSupabaseErrorCode(error) === DUPLICATE_KEY_ERROR_CODE) {
      const duplicateJob = await getActiveQaIndexJob({ userDocumentId, userId });

      if (duplicateJob) {
        return {
          job: duplicateJob,
          reused: true,
        };
      }
    }

    throw toSupabaseServiceError(error, "qa_index_job_create_failed", "Could not create QA index job.");
  }

  const job = rowToQaIndexJob(data);

  enqueueQaIndexJob(job);

  return {
    job,
    reused: false,
  };
}

async function getActiveQaIndexJob({ userDocumentId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_index_jobs")
    .select(QA_INDEX_JOB_COLUMNS)
    .eq("user_id", userId)
    .eq("user_document_id", userDocumentId)
    .in("status", QA_INDEX_ACTIVE_STATUSES)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_index_job_query_failed", "Could not read QA index job.");
  }

  return data ? rowToQaIndexJob(data) : undefined;
}

export async function requireUserDocument({ userDocumentId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_documents")
    .select(USER_DOCUMENT_COLUMNS)
    .eq("id", userDocumentId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_document_query_failed", "Could not read document.");
  }

  if (!data) {
    throw new SupabaseServiceError(
      404,
      "qa_document_not_found",
      "Document was not found for this user.",
    );
  }

  return data;
}

async function requireQaThread({ threadId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_threads")
    .select(QA_THREAD_COLUMNS)
    .eq("id", threadId)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw toSupabaseServiceError(error, "qa_thread_query_failed", "Could not read QA thread.");
  }

  if (!data) {
    throw new SupabaseServiceError(
      404,
      "qa_thread_not_found",
      "QA thread was not found for this user.",
    );
  }

  return rowToQaThread(data);
}

async function touchQaThread({ threadId, userId }) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_qa_threads")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", threadId)
    .eq("user_id", userId)
    .select(QA_THREAD_COLUMNS)
    .single();

  if (error) {
    throw toSupabaseServiceError(error, "qa_thread_update_failed", "Could not update QA thread.");
  }

  return rowToQaThread(data);
}

async function softDeleteRows({
  code,
  filter,
  table,
  userId,
  when,
}) {
  const query = requireSupabaseServiceClient()
    .from(table)
    .update({ deleted_at: when })
    .eq("user_id", userId)
    .is("deleted_at", null);
  const { error } = await filter(query);

  if (error) {
    throw toSupabaseServiceError(error, code, `Could not delete rows from ${table}.`);
  }
}

function rowToQaIndexJob(row) {
  return {
    chunkerVersion: row.chunker_version,
    cloudDocumentId: row.user_document_id,
    contentSha256: row.content_sha256,
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    embeddingDimensions: typeof row.embedding_dimensions === "number"
      ? row.embedding_dimensions
      : undefined,
    embeddingModel: row.embedding_model ?? "none",
    errorMessage: row.error_message ?? undefined,
    finishedAt: parseIsoTime(row.finished_at),
    id: row.id,
    payload: row.payload ?? undefined,
    pdfFingerprint: row.pdf_fingerprint,
    progressPercent: typeof row.progress_percent === "number" ? row.progress_percent : undefined,
    referenceMatcherVersion: row.reference_matcher_version,
    retrieverVersion: row.retriever_version,
    source: row.source,
    startedAt: parseIsoTime(row.started_at),
    status: row.status,
    updatedAt: parseIsoTime(row.updated_at) ?? Date.now(),
  };
}

function rowToQaThread(row) {
  return {
    activeCloudDocumentId: row.active_user_document_id ?? undefined,
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    id: row.id,
    referenceDocumentIds: Array.isArray(row.reference_document_ids)
      ? row.reference_document_ids
      : [],
    scope: row.scope,
    title: row.title,
    updatedAt: parseIsoTime(row.updated_at) ?? Date.now(),
  };
}

function rowToQaMessage(row) {
  return {
    agentSteps: [],
    citations: [],
    content: row.content,
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    errorMessage: row.error_message ?? undefined,
    id: row.id,
    model: row.model ?? undefined,
    promptVersion: row.prompt_version ?? undefined,
    retrievalSnapshot: row.retrieval_snapshot ?? undefined,
    role: row.role,
    status: row.status,
    threadId: row.thread_id,
    updatedAt: parseIsoTime(row.updated_at) ?? Date.now(),
    usage: row.usage ?? undefined,
  };
}

function rowToQaAgentStep(row) {
  return {
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    evidenceIds: Array.isArray(row.evidence_ids) ? row.evidence_ids.filter(Boolean) : [],
    id: row.id,
    kind: row.kind,
    messageId: row.message_id,
    payload: row.payload ?? undefined,
    status: row.status ?? "success",
    stepIndex: row.step_index,
    summary: row.summary,
    toolName: row.tool_name ?? undefined,
  };
}

function rowToQaToolCall(row) {
  return {
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    errorMessage: row.error_message ?? undefined,
    finishedAt: parseIsoTime(row.finished_at),
    id: row.id,
    input: row.input ?? {},
    outputSummary: row.output_summary ?? undefined,
    resultEvidenceIds: Array.isArray(row.result_evidence_ids)
      ? row.result_evidence_ids.filter(Boolean)
      : [],
    startedAt: parseIsoTime(row.started_at) ?? Date.now(),
    status: row.status,
    stepId: row.step_id,
    toolName: row.tool_name,
  };
}

function rowToQaCitation(row) {
  return {
    chunkId: row.chunk_id,
    cloudDocumentId: row.user_document_id,
    confidence: row.confidence,
    createdAt: parseIsoTime(row.created_at) ?? Date.now(),
    deletedAt: parseIsoTime(row.deleted_at),
    documentTitle: row.document_title,
    id: row.id,
    messageId: row.message_id,
    pageEnd: row.page_end,
    pageStart: row.page_start,
    pdfFingerprint: row.pdf_fingerprint,
    quotedText: row.quoted_text,
    sectionPath: row.section_path ?? undefined,
  };
}

function createThreadTitle(question) {
  const title = String(question ?? "").replace(/\s+/g, " ").trim();

  if (!title) {
    return "Paper question";
  }

  return title.length > 80 ? `${title.slice(0, 77).trim()}...` : title;
}

function toSupabaseServiceError(error, code, fallbackMessage) {
  return new SupabaseServiceError(
    500,
    code,
    error?.message || fallbackMessage,
  );
}

function getSupabaseErrorCode(error) {
  return typeof error?.code === "string" ? error.code : undefined;
}

function parseIsoTime(value) {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatOptionalDate(value) {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  return typeof value === "string" ? value : undefined;
}
