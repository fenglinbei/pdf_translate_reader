import { requireSupabaseClient } from "../auth/supabaseClient";
import type { AppSettings } from "../types/domain";
import { requireCurrentUserId } from "./currentUser";

type SettingsRow = {
  payload: AppSettings;
  library_metadata_ai_enabled: boolean;
};

export async function getCloudSettings() {
  const userId = await requireCurrentUserId();
  const { data, error } = await requireSupabaseClient()
    .from("user_settings")
    .select("payload,library_metadata_ai_enabled")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const row = data as unknown as SettingsRow | null;
  return row ? { ...row.payload, libraryMetadataAiEnabled: row.library_metadata_ai_enabled } : undefined;
}

export async function putCloudSettings(settings: AppSettings, options: { writeMetadataAi?: boolean } = {}) {
  const userId = await requireCurrentUserId();
  const { data, error } = await requireSupabaseClient()
    .from("user_settings")
    .upsert({
      payload: settings,
      updated_at: new Date().toISOString(),
      user_id: userId,
      ...(options.writeMetadataAi ? { library_metadata_ai_enabled: settings.libraryMetadataAiEnabled } : {}),
    }, {
      onConflict: "user_id",
    })
    .select("payload,library_metadata_ai_enabled")
    .single();

  if (error) {
    throw error;
  }
  const row = data as unknown as SettingsRow;
  return { ...row.payload, libraryMetadataAiEnabled: row.library_metadata_ai_enabled };
}
