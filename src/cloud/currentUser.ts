import { requireSupabaseClient } from "../auth/supabaseClient";

export async function requireCurrentUserId() {
  const client = requireSupabaseClient();
  const { data, error } = await client.auth.getUser();

  if (error || !data.user) {
    throw error ?? new Error("You must sign in before syncing cloud data.");
  }

  return data.user.id;
}
