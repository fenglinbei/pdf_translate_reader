import { getSupabaseAccessToken } from "../auth/supabaseClient";
import type { PdfLibraryEntry } from "../types/domain";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";
const MATHPIX_REQUEST_TIMEOUT_MS = 30_000;

export type MathpixSubmitResponse = {
  deleteRemoteAfterCache?: boolean;
  mathpixPdfId: string;
  status?: string;
};

export type MathpixStatusResponse = {
  error?: string;
  numPages?: number;
  numPagesCompleted?: number;
  percentDone?: number;
  status: string;
};

export async function submitMathpixDocument(entry: PdfLibraryEntry, signal?: AbortSignal) {
  const accessToken = await requireAccessToken();
  const timeout = createTimeoutSignal(signal);

  try {
    const response = await fetch(`${apiBaseUrl}/mathpix/documents`, {
      body: entry.blob,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf",
        "X-PDF-File-Name": encodeURIComponent(entry.fileName),
      },
      method: "POST",
      signal: timeout.signal,
    });

    return readJsonResponse<MathpixSubmitResponse>(response);
  } finally {
    timeout.dispose();
  }
}

export async function getMathpixDocumentStatus(mathpixPdfId: string, signal?: AbortSignal) {
  const accessToken = await requireAccessToken();
  const timeout = createTimeoutSignal(signal);

  try {
    const response = await fetch(
      `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}/status`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        method: "GET",
        signal: timeout.signal,
      },
    );

    return readJsonResponse<MathpixStatusResponse>(response);
  } finally {
    timeout.dispose();
  }
}

export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "lines.json",
  signal?: AbortSignal,
): Promise<unknown>;
export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "mmd",
  signal?: AbortSignal,
): Promise<string>;
export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "lines.json" | "mmd",
  signal?: AbortSignal,
) {
  const accessToken = await requireAccessToken();
  const timeout = createTimeoutSignal(signal);

  try {
    const response = await fetch(
      `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}/result?format=${encodeURIComponent(format)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        method: "GET",
        signal: timeout.signal,
      },
    );

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }

    return format === "mmd" ? response.text() : response.json();
  } finally {
    timeout.dispose();
  }
}

export async function deleteMathpixRemoteDocument(mathpixPdfId: string, signal?: AbortSignal) {
  const accessToken = await requireAccessToken();
  const timeout = createTimeoutSignal(signal);

  try {
    const response = await fetch(
      `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        method: "DELETE",
        signal: timeout.signal,
      },
    );

    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
  } finally {
    timeout.dispose();
  }
}

async function requireAccessToken() {
  const accessToken = await getSupabaseAccessToken();

  if (!accessToken) {
    throw new Error("Sign in before parsing PDFs.");
  }

  return accessToken;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response) {
  try {
    const payload = await response.json();

    if (typeof payload?.error?.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || `Request failed with status ${response.status}`;
}

function createTimeoutSignal(parentSignal?: AbortSignal) {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => {
    abortController.abort();
  }, MATHPIX_REQUEST_TIMEOUT_MS);

  function handleParentAbort() {
    abortController.abort();
  }

  if (parentSignal?.aborted) {
    abortController.abort();
  } else {
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });
  }

  return {
    dispose: () => {
      window.clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", handleParentAbort);
    },
    signal: abortController.signal,
  };
}
