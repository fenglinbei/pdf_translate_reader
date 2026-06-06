import { getSupabaseAccessToken } from "../auth/supabaseClient";
import type { PdfLibraryEntry } from "../types/domain";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

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

export async function submitMathpixDocument(entry: PdfLibraryEntry) {
  const accessToken = await requireAccessToken();
  const response = await fetch(`${apiBaseUrl}/mathpix/documents`, {
    body: entry.blob,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/pdf",
      "X-PDF-File-Name": encodeURIComponent(entry.fileName),
    },
    method: "POST",
  });

  return readJsonResponse<MathpixSubmitResponse>(response);
}

export async function getMathpixDocumentStatus(mathpixPdfId: string) {
  const accessToken = await requireAccessToken();
  const response = await fetch(
    `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}/status`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: "GET",
    },
  );

  return readJsonResponse<MathpixStatusResponse>(response);
}

export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "lines.json",
): Promise<unknown>;
export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "mmd",
): Promise<string>;
export async function getMathpixDocumentResult(
  mathpixPdfId: string,
  format: "lines.json" | "mmd",
) {
  const accessToken = await requireAccessToken();
  const response = await fetch(
    `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}/result?format=${encodeURIComponent(format)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: "GET",
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return format === "mmd" ? response.text() : response.json();
}

export async function deleteMathpixRemoteDocument(mathpixPdfId: string) {
  const accessToken = await requireAccessToken();
  const response = await fetch(
    `${apiBaseUrl}/mathpix/documents/${encodeURIComponent(mathpixPdfId)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      method: "DELETE",
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
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
