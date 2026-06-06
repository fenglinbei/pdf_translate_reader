const DEFAULT_MATHPIX_API_BASE_URL = "https://api.mathpix.com";
const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;

export class MathpixClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MathpixClientError";
    this.code = options.code ?? "mathpix_error";
    this.statusCode = options.statusCode ?? 500;
  }
}

export function getMathpixRuntimeConfig() {
  return {
    apiBaseUrl: process.env.MATHPIX_API_BASE_URL ?? DEFAULT_MATHPIX_API_BASE_URL,
    appId: process.env.MATHPIX_APP_ID,
    appKey: process.env.MATHPIX_APP_KEY,
    deleteRemoteAfterCache: String(process.env.MATHPIX_DELETE_REMOTE_AFTER_CACHE ?? "false") === "true",
    maxPdfBytes: Number(process.env.MATHPIX_MAX_PDF_BYTES ?? DEFAULT_MAX_PDF_BYTES),
  };
}

export async function submitMathpixPdf({ fileBuffer, fileName, options }) {
  const config = requireMathpixConfig();
  const form = new FormData();

  form.append("file", new Blob([fileBuffer], { type: "application/pdf" }), fileName || "document.pdf");
  form.append("options_json", JSON.stringify(options));

  const response = await fetch(`${config.apiBaseUrl}/v3/pdf`, {
    body: form,
    headers: createMathpixHeaders(config),
    method: "POST",
  });
  const payload = await readJsonPayload(response);

  if (!response.ok) {
    throw toMathpixError(response, payload, "Could not submit PDF to Mathpix.");
  }

  const mathpixPdfId = payload.pdf_id;

  if (typeof mathpixPdfId !== "string" || !mathpixPdfId) {
    throw new MathpixClientError("Mathpix response did not include a PDF id.", {
      code: "mathpix_missing_pdf_id",
      statusCode: 502,
    });
  }

  return {
    deleteRemoteAfterCache: config.deleteRemoteAfterCache,
    mathpixPdfId,
    status: payload.status,
  };
}

export async function getMathpixPdfStatus(mathpixPdfId) {
  const config = requireMathpixConfig();
  const response = await fetch(`${config.apiBaseUrl}/v3/pdf/${encodeURIComponent(mathpixPdfId)}`, {
    headers: createMathpixHeaders(config),
    method: "GET",
  });
  const payload = await readJsonPayload(response);

  if (!response.ok) {
    throw toMathpixError(response, payload, "Could not read Mathpix PDF status.");
  }

  return {
    error: typeof payload.error === "string" ? payload.error : undefined,
    numPages: normalizeNumber(payload.num_pages),
    numPagesCompleted: normalizeNumber(payload.num_pages_completed),
    percentDone: normalizeNumber(payload.percent_done),
    status: typeof payload.status === "string" ? payload.status : "processing",
  };
}

export async function getMathpixPdfResult(mathpixPdfId, format) {
  const config = requireMathpixConfig();
  const response = await fetch(
    `${config.apiBaseUrl}/v3/pdf/${encodeURIComponent(mathpixPdfId)}.${format}`,
    {
      headers: createMathpixHeaders(config),
      method: "GET",
    },
  );

  if (!response.ok) {
    const payload = await readJsonPayload(response).catch(() => ({}));
    throw toMathpixError(response, payload, "Could not download Mathpix PDF result.");
  }

  return format === "mmd" ? response.text() : response.json();
}

export async function deleteMathpixPdf(mathpixPdfId) {
  const config = requireMathpixConfig();
  const response = await fetch(`${config.apiBaseUrl}/v3/pdf/${encodeURIComponent(mathpixPdfId)}`, {
    headers: createMathpixHeaders(config),
    method: "DELETE",
  });

  if (!response.ok) {
    const payload = await readJsonPayload(response).catch(() => ({}));
    throw toMathpixError(response, payload, "Could not delete Mathpix PDF data.");
  }
}

function requireMathpixConfig() {
  const config = getMathpixRuntimeConfig();

  if (!config.appId || !config.appKey) {
    throw new MathpixClientError("Mathpix API credentials are not configured.", {
      code: "mathpix_api_key_missing",
      statusCode: 503,
    });
  }

  return config;
}

function createMathpixHeaders(config) {
  return {
    app_id: config.appId,
    app_key: config.appKey,
  };
}

async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function toMathpixError(response, payload, fallbackMessage) {
  const message =
    getPayloadErrorMessage(payload) ||
    response.statusText ||
    fallbackMessage;

  return new MathpixClientError(message, {
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

  return "mathpix_error";
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
