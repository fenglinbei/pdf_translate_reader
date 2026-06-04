import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_AUTH_STORAGE_KEY = "pdf-translate-reader-auth-v1";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

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

function migrateDefaultSupabaseAuthStorage() {
  const storage = getBrowserLocalStorage();

  if (!storage || !supabaseUrl) {
    return;
  }

  try {
    if (storage.getItem(SUPABASE_AUTH_STORAGE_KEY)) {
      return;
    }

    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
    const defaultStorageKey = `sb-${projectRef}-auth-token`;
    const storedSession = storage.getItem(defaultStorageKey);

    if (storedSession) {
      storage.setItem(SUPABASE_AUTH_STORAGE_KEY, storedSession);
    }
  } catch {
    // Keep auth initialization resilient if the configured URL is malformed.
  }
}

migrateDefaultSupabaseAuthStorage();

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
        storageKey: SUPABASE_AUTH_STORAGE_KEY,
      },
    })
  : undefined;

export function requireSupabaseClient() {
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }

  return supabase;
}

export async function getSupabaseAccessToken() {
  if (!supabase) {
    return undefined;
  }

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    throw error;
  }

  return data.session?.access_token;
}
