import { writeJson } from "../http/json.mjs";
import {
  deleteMathpixPdf,
  getMathpixPdfResult,
  getMathpixPdfStatus,
  getMathpixRuntimeConfig,
  MathpixClientError,
  submitMathpixPdf,
} from "../mathpix/client.mjs";

const MATHPIX_PARSE_OPTIONS = {
  enable_tables_fallback: true,
  idiomatic_eqn_arrays: true,
  include_equation_tags: true,
  include_page_breaks: true,
  include_page_info: false,
  math_display_delimiters: ["\\[", "\\]"],
  math_inline_delimiters: ["\\(", "\\)"],
  rm_fonts: false,
  rm_spaces: true,
  streaming: false,
};

export async function handleMathpixRoute(request, response, url) {
  const route = parseMathpixRoute(url.pathname);

  if (!route) {
    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found",
      },
    });
    return;
  }

  try {
    if (request.method === "POST" && route.kind === "documents") {
      await handleSubmitDocument(request, response);
      return;
    }

    if (request.method === "GET" && route.kind === "status") {
      await handleGetStatus(route.mathpixPdfId, response);
      return;
    }

    if (request.method === "GET" && route.kind === "result") {
      await handleGetResult(route.mathpixPdfId, url, response);
      return;
    }

    if (request.method === "DELETE" && route.kind === "document") {
      await handleDeleteDocument(route.mathpixPdfId, response);
      return;
    }

    writeJson(response, 405, {
      error: {
        code: "method_not_allowed",
        message: "Method not allowed",
      },
    });
  } catch (error) {
    const serializedError = serializeMathpixError(error);

    writeJson(response, getErrorStatusCode(error), {
      error: serializedError,
    });
  }
}

async function handleSubmitDocument(request, response) {
  const contentType = request.headers["content-type"] ?? "";

  if (!String(contentType).startsWith("application/pdf")) {
    writeJson(response, 400, {
      error: {
        code: "invalid_mathpix_document",
        message: "Request body must be an application/pdf payload.",
      },
    });
    return;
  }

  const fileBuffer = await readRequestBody(request, getMathpixRuntimeConfig().maxPdfBytes);
  const fileName = decodeHeaderFileName(request.headers["x-pdf-file-name"]);
  const result = await submitMathpixPdf({
    fileBuffer,
    fileName,
    options: MATHPIX_PARSE_OPTIONS,
  });

  writeJson(response, 200, result);
}

async function handleGetStatus(mathpixPdfId, response) {
  const status = await getMathpixPdfStatus(mathpixPdfId);

  writeJson(response, 200, status);
}

async function handleGetResult(mathpixPdfId, url, response) {
  const format = url.searchParams.get("format");

  if (format !== "lines.json" && format !== "mmd") {
    writeJson(response, 400, {
      error: {
        code: "invalid_mathpix_result_format",
        message: "Supported Mathpix result formats are lines.json and mmd.",
      },
    });
    return;
  }

  const result = await getMathpixPdfResult(mathpixPdfId, format);

  if (format === "mmd") {
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(result);
    return;
  }

  writeJson(response, 200, result);
}

async function handleDeleteDocument(mathpixPdfId, response) {
  await deleteMathpixPdf(mathpixPdfId);
  response.writeHead(204);
  response.end();
}

function parseMathpixRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean);

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "mathpix" && parts[2] === "documents") {
    return { kind: "documents" };
  }

  if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "mathpix" || parts[2] !== "documents") {
    return undefined;
  }

  const mathpixPdfId = decodeURIComponent(parts[3]);

  if (parts.length === 4) {
    return { kind: "document", mathpixPdfId };
  }

  if (parts.length === 5 && parts[4] === "status") {
    return { kind: "status", mathpixPdfId };
  }

  if (parts.length === 5 && parts[4] === "result") {
    return { kind: "result", mathpixPdfId };
  }

  return undefined;
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > maxBytes) {
      throw new MathpixClientError("PDF is too large for Mathpix parsing.", {
        code: "mathpix_pdf_too_large",
        statusCode: 413,
      });
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new MathpixClientError("PDF payload is empty.", {
      code: "mathpix_pdf_empty",
      statusCode: 400,
    });
  }

  return Buffer.concat(chunks);
}

function decodeHeaderFileName(value) {
  if (typeof value !== "string" || !value) {
    return "document.pdf";
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function serializeMathpixError(error) {
  if (error instanceof MathpixClientError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: "mathpix_proxy_error",
    message: error instanceof Error ? error.message : "Mathpix parsing failed.",
  };
}

function getErrorStatusCode(error) {
  return error instanceof MathpixClientError ? error.statusCode : 500;
}
