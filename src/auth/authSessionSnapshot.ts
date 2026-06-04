import type { Session, SupabaseClient } from "@supabase/supabase-js";

const AUTH_SESSION_SNAPSHOT_STORAGE_KEY = "pdf-translate-reader-auth-session-v1";

type AuthSessionSnapshot = {
  accessToken: string;
  expiresAt?: number;
  refreshToken: string;
  updatedAt: number;
};

export function saveAuthSessionSnapshot(session: Session | null) {
  const storage = getBrowserLocalStorage();

  if (!storage) {
    return;
  }

  if (!session) {
    clearAuthSessionSnapshot();
    return;
  }

  try {
    storage.setItem(
      AUTH_SESSION_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        accessToken: session.access_token,
        expiresAt: session.expires_at,
        refreshToken: session.refresh_token,
        updatedAt: Date.now(),
      } satisfies AuthSessionSnapshot),
    );
  } catch {
    // Auth still works for the current tab if the browser rejects persistence.
  }
}

export function clearAuthSessionSnapshot() {
  const storage = getBrowserLocalStorage();

  if (!storage) {
    return;
  }

  try {
    storage.removeItem(AUTH_SESSION_SNAPSHOT_STORAGE_KEY);
  } catch {
    // Nothing to clear if localStorage is unavailable.
  }
}

export async function restoreAuthSessionFromSnapshot(client: SupabaseClient) {
  const snapshot = getAuthSessionSnapshot();

  if (!snapshot) {
    return null;
  }

  const { data, error } = await client.auth.setSession({
    access_token: snapshot.accessToken,
    refresh_token: snapshot.refreshToken,
  });

  if (error || !data.session) {
    clearAuthSessionSnapshot();
    return null;
  }

  saveAuthSessionSnapshot(data.session);

  return data.session;
}

function getAuthSessionSnapshot() {
  const storage = getBrowserLocalStorage();

  if (!storage) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storage.getItem(AUTH_SESSION_SNAPSHOT_STORAGE_KEY) ?? "null");

    if (
      isRecord(parsed) &&
      typeof parsed.accessToken === "string" &&
      parsed.accessToken &&
      typeof parsed.refreshToken === "string" &&
      parsed.refreshToken
    ) {
      return parsed as AuthSessionSnapshot;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getBrowserLocalStorage() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
