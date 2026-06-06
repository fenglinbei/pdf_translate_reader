import { createClient } from "@supabase/supabase-js";
import { getSupabaseRuntimeConfig } from "./config.mjs";

let supabaseServiceClient;

export function requireSupabaseServiceClient() {
  const config = getSupabaseRuntimeConfig();

  if (!config.url || !config.serviceRoleKey) {
    throw new SupabaseServiceError(
      500,
      "supabase_service_not_configured",
      "Supabase service role is not configured.",
    );
  }

  supabaseServiceClient ??= createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseServiceClient;
}

export class SupabaseServiceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "SupabaseServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
