import { createClient } from "@supabase/supabase-js";
import { getSupabaseRuntimeConfig } from "./config.mjs";

let supabaseClient;

export async function requireAuthenticatedUser(request) {
  const config = getSupabaseRuntimeConfig();

  if (!config.configured) {
    throw new SupabaseAuthError(
      500,
      "supabase_not_configured",
      "Supabase is not configured.",
    );
  }

  const token = getBearerToken(request);

  if (!token) {
    throw new SupabaseAuthError(
      401,
      "auth_token_missing",
      "Authorization bearer token is required.",
    );
  }

  const client = getSupabaseClient(config);
  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) {
    throw new SupabaseAuthError(
      401,
      "auth_token_invalid",
      "Authorization bearer token is invalid.",
    );
  }

  return data.user;
}

export class SupabaseAuthError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "SupabaseAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function getSupabaseClient(config) {
  supabaseClient ??= createClient(config.url, config.anonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return supabaseClient;
}

function getBearerToken(request) {
  const authorization = request.headers.authorization;

  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);

  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}
