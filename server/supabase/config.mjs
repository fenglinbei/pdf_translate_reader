export function getSupabaseRuntimeConfig() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return {
    anonKey,
    configured: Boolean(url && anonKey),
    serviceRoleConfigured: Boolean(url && serviceRoleKey),
    serviceRoleKey,
    url,
  };
}
