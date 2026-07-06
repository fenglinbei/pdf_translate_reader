import { writeJson } from "../http/json.mjs";
import {
  createOrUpdateIndexJob,
  getLatestQaIndexJob,
} from "../supabase/qa.mjs";
import { SupabaseServiceError } from "../supabase/service.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const QA_INDEX_SOURCES = new Set(["mathpix-v3-pdf"]);

export async function handleQaRoute(request, response, url, user) {
  try {
    if (request.method === "GET" && url.pathname === "/api/qa/index-jobs") {
      await handleGetIndexJob(url, response, user);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/qa/index-jobs") {
      await handleCreateIndexJob(request, response, user);
      return;
    }

    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
  } catch (error) {
    writeJson(response, getErrorStatusCode(error), {
      error: serializeError(error),
    });
  }
}

async function handleGetIndexJob(url, response, user) {
  const userDocumentId = normalizeUuidLike(url.searchParams.get("documentId"));

  if (!userDocumentId) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: "documentId is required.",
      },
    });
    return;
  }

  const job = await getLatestQaIndexJob({
    userDocumentId,
    userId: user.id,
  });

  writeJson(response, 200, {
    job: job ?? null,
  });
}

async function handleCreateIndexJob(request, response, user) {
  let body;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: error instanceof Error ? error.message : "Invalid QA index job request.",
      },
    });
    return;
  }

  const userDocumentId = normalizeUuidLike(body?.userDocumentId);
  const source = typeof body?.source === "string" ? body.source : undefined;

  if (!userDocumentId || !source) {
    writeJson(response, 400, {
      error: {
        code: "invalid_qa_index_job_request",
        message: "userDocumentId and source are required.",
      },
    });
    return;
  }

  if (!QA_INDEX_SOURCES.has(source)) {
    writeJson(response, 400, {
      error: {
        code: "qa_index_source_not_supported",
        message: "PDF text indexing is not supported yet. Start MathPix parsing first, then build the MathPix index.",
      },
    });
    return;
  }

  const result = await createOrUpdateIndexJob({
    source,
    userDocumentId,
    userId: user.id,
  });

  writeJson(response, result.reused ? 200 : 201, result);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_REQUEST_BYTES) {
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeUuidLike(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function serializeError(error) {
  if (error instanceof SupabaseServiceError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: "qa_route_error",
    message: error instanceof Error ? error.message : "QA request failed.",
  };
}

function getErrorStatusCode(error) {
  return error instanceof SupabaseServiceError ? error.statusCode : 500;
}
