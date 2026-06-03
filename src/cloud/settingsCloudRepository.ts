import { requireSupabaseClient } from "../auth/supabaseClient";
import type { AppSettings } from "../types/domain";
import { requireCurrentUserId } from "./currentUser";

type SettingsRow = {
  payload: AppSettings;
};

export async function getCloudSettings() {
  const userId = await requireCurrentUserId();
  const { data, error } = await requireSupabaseClient()
    .from("user_settings")
    .select("payload")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as unknown as SettingsRow | null)?.payload;
}

export async function putCloudSettings(settings: AppSettings) {
  const userId = await requireCurrentUserId();
  const { error } = await requireSupabaseClient()
    .from("user_settings")
    .upsert({
      payload: settings,
      updated_at: new Date().toISOString(),
      user_id: userId,
    }, {
      onConflict: "user_id",
    });

  if (error) {
    throw error;
  }
}
