import { getSupabaseAccessToken } from "../auth/supabaseClient";
import type { QaIndexJob, QaIndexSource } from "../types/domain";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

type QaIndexJobResponse = {
  job: QaIndexJob | null;
};

type CreateQaIndexJobResponse = {
  job: QaIndexJob;
  reused: boolean;
};

export async function getQaIndexJob(cloudDocumentId: string) {
  const response = await fetch(
    `${apiBaseUrl}/qa/index-jobs?documentId=${encodeURIComponent(cloudDocumentId)}`,
    {
      headers: {
        Accept: "application/json",
        ...await getAuthHeader(),
      },
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const payload = await response.json() as QaIndexJobResponse;

  return payload.job ?? undefined;
}

export async function createQaIndexJob(input: {
  cloudDocumentId: string;
  source: QaIndexSource;
}) {
  const response = await fetch(`${apiBaseUrl}/qa/index-jobs`, {
    body: JSON.stringify({
      source: input.source,
      userDocumentId: input.cloudDocumentId,
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...await getAuthHeader(),
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json() as Promise<CreateQaIndexJobResponse>;
}

async function getAuthHeader() {
  const accessToken = await getSupabaseAccessToken();

  if (!accessToken) {
    throw new Error("Sign in before using paper QA.");
  }

  return {
    Authorization: `Bearer ${accessToken}`,
  };
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

