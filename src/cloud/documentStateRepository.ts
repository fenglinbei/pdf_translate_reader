import { getAppDb } from "../cache";
import { requireSupabaseClient } from "../auth/supabaseClient";
import type {
  PaperContextRecord,
  TranslationCacheEntry,
  TranslationPin,
} from "../types/domain";
import type { StoredPinnedTranslationCard } from "../translation/floatingCardTypes";
import { deleteCloudMathpixCacheByDocument } from "../mathpix/mathpixCloudRepository";
import { deleteCloudQaStateByDocument } from "./qaCloudRepository";
import { getEffectiveTranslationStyle } from "../translation/translationStyle";
import { requireCurrentUserId } from "./currentUser";

type PayloadRow<T> = {
  payload: T;
};

const DOCUMENT_STATE_STORES = [
  "pins",
  "translationCache",
  "paperContexts",
  "pinnedTranslationCards",
] as const;

export type HydratedCloudDocumentState = {
  paperContext?: PaperContextRecord;
  pinnedTranslationCards: StoredPinnedTranslationCard[];
  pins: TranslationPin[];
  translationCacheEntries: TranslationCacheEntry[];
};

export async function hydrateCloudDocumentState(
  cloudDocumentId: string,
  pdfFingerprint: string,
): Promise<HydratedCloudDocumentState> {
  const [
    pins,
    translationCacheEntries,
    paperContext,
    pinnedTranslationCards,
  ] = await Promise.all([
    listCloudPins(cloudDocumentId),
    listCloudTranslationCacheEntries(cloudDocumentId),
    getCloudPaperContext(cloudDocumentId),
    listCloudPinnedTranslationCards(cloudDocumentId),
  ]);

  await replaceLocalDocumentState({
    paperContext,
    pdfFingerprint,
    pinnedTranslationCards,
    pins,
    translationCacheEntries,
  });

  return {
    paperContext,
    pinnedTranslationCards,
    pins,
    translationCacheEntries,
  };
}

export async function syncPinToCloud(pin: TranslationPin) {
  if (!pin.cloudDocumentId) {
    return;
  }

  const userId = await requireCurrentUserId();
  const client = requireSupabaseClient();
  const { error } = await client
    .from("user_document_pins")
    .upsert({
      created_at: toIsoTime(pin.createdAt),
      deleted_at: null,
      pdf_fingerprint: pin.pdfFingerprint,
      payload: pin,
      page_index: pin.pageIndex,
      pin_id: pin.id,
      updated_at: toIsoTime(pin.updatedAt),
      user_document_id: pin.cloudDocumentId,
      user_id: userId,
    }, {
      onConflict: "user_document_id,pin_id",
    });

  if (error) {
    throw error;
  }
}

export async function deleteCloudPin(cloudDocumentId: string | undefined, pinId: string) {
  if (!cloudDocumentId) {
    return;
  }

  const { error } = await requireSupabaseClient()
    .from("user_document_pins")
    .update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_document_id", cloudDocumentId)
    .eq("pin_id", pinId);

  if (error) {
    throw error;
  }
}

export async function deleteCloudPinsByDocument(cloudDocumentId: string | undefined) {
  if (!cloudDocumentId) {
    return;
  }

  const now = new Date().toISOString();
  const { error } = await requireSupabaseClient()
    .from("user_document_pins")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

export async function syncTranslationCacheToCloud(entry: TranslationCacheEntry) {
  if (!entry.cloudDocumentId) {
    return;
  }

  const userId = await requireCurrentUserId();
  const { error } = await requireSupabaseClient()
    .from("user_translation_cache")
    .upsert({
      cache_key: entry.cacheKey,
      created_at: toIsoTime(entry.createdAt),
      deleted_at: null,
      pdf_fingerprint: entry.pdfFingerprint,
      payload: entry,
      updated_at: toIsoTime(entry.updatedAt),
      user_document_id: entry.cloudDocumentId,
      user_id: userId,
    }, {
      onConflict: "user_document_id,cache_key",
    });

  if (error) {
    throw error;
  }
}

export async function deleteCloudTranslationCacheByDocument(cloudDocumentId: string | undefined) {
  if (!cloudDocumentId) {
    return;
  }

  const now = new Date().toISOString();
  const { error } = await requireSupabaseClient()
    .from("user_translation_cache")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

export async function deleteAllCloudTranslationCache() {
  const userId = await requireCurrentUserId();
  const now = new Date().toISOString();
  const { error } = await requireSupabaseClient()
    .from("user_translation_cache")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_id", userId)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

export async function syncPaperContextToCloud(record: PaperContextRecord) {
  if (!record.cloudDocumentId) {
    return;
  }

  const userId = await requireCurrentUserId();
  const { error } = await requireSupabaseClient()
    .from("user_paper_contexts")
    .upsert({
      deleted_at: null,
      pdf_fingerprint: record.pdfFingerprint,
      payload: record,
      updated_at: toIsoTime(record.updatedAt),
      user_document_id: record.cloudDocumentId,
      user_id: userId,
    }, {
      onConflict: "user_document_id",
    });

  if (error) {
    throw error;
  }
}

export async function deleteCloudPaperContext(cloudDocumentId: string | undefined) {
  if (!cloudDocumentId) {
    return;
  }

  const { error } = await requireSupabaseClient()
    .from("user_paper_contexts")
    .update({
      deleted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_document_id", cloudDocumentId);

  if (error) {
    throw error;
  }
}

export async function syncPinnedTranslationCardToCloud(record: StoredPinnedTranslationCard) {
  if (!record.cloudDocumentId) {
    return;
  }

  const userId = await requireCurrentUserId();
  const { error } = await requireSupabaseClient()
    .from("user_pinned_translation_cards")
    .upsert({
      card_key: record.key,
      created_at: toIsoTime(record.createdAt),
      deleted_at: null,
      pdf_fingerprint: record.pdfFingerprint,
      payload: record,
      updated_at: toIsoTime(record.updatedAt),
      user_document_id: record.cloudDocumentId,
      user_id: userId,
    }, {
      onConflict: "user_document_id,card_key",
    });

  if (error) {
    throw error;
  }
}

export async function deleteCloudPinnedTranslationCard(
  cloudDocumentId: string | undefined,
  cardKey: string,
) {
  if (!cloudDocumentId) {
    return;
  }

  const now = new Date().toISOString();
  const { error } = await requireSupabaseClient()
    .from("user_pinned_translation_cards")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_document_id", cloudDocumentId)
    .eq("card_key", cardKey);

  if (error) {
    throw error;
  }
}

export async function deleteCloudDocumentState(
  cloudDocumentId: string | undefined,
  contentSha256?: string,
) {
  if (!cloudDocumentId) {
    return;
  }

  await Promise.all([
    deleteCloudPinsByDocument(cloudDocumentId),
    deleteCloudTranslationCacheByDocument(cloudDocumentId),
    deleteCloudPaperContext(cloudDocumentId),
    deleteAllCloudPinnedTranslationCardsByDocument(cloudDocumentId),
    deleteCloudMathpixCacheByDocument(cloudDocumentId, contentSha256),
    deleteCloudQaStateByDocument(cloudDocumentId),
  ]);
}

async function listCloudPins(cloudDocumentId: string) {
  const { data, error } = await requireSupabaseClient()
    .from("user_document_pins")
    .select("payload")
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as Array<PayloadRow<TranslationPin>>)
    .map((row) => normalizeTranslationStylePayload(row.payload));
}

async function listCloudTranslationCacheEntries(cloudDocumentId: string) {
  const { data, error } = await requireSupabaseClient()
    .from("user_translation_cache")
    .select("payload")
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as Array<PayloadRow<TranslationCacheEntry>>)
    .map((row) => normalizeTranslationStylePayload(row.payload));
}

async function getCloudPaperContext(cloudDocumentId: string) {
  const { data, error } = await requireSupabaseClient()
    .from("user_paper_contexts")
    .select("payload")
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const payload = (data as unknown as PayloadRow<PaperContextRecord> | null)?.payload;

  return payload ? normalizeTranslationStylePayload(payload) : undefined;
}

async function listCloudPinnedTranslationCards(cloudDocumentId: string) {
  const { data, error } = await requireSupabaseClient()
    .from("user_pinned_translation_cards")
    .select("payload")
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true });

  if (error) {
    throw error;
  }

  return ((data ?? []) as unknown as Array<PayloadRow<StoredPinnedTranslationCard>>)
    .map((row) => row.payload);
}

async function replaceLocalDocumentState(input: HydratedCloudDocumentState & {
  pdfFingerprint: string;
}) {
  const db = await getAppDb();
  const transaction = db.transaction(DOCUMENT_STATE_STORES, "readwrite");
  const pinsStore = transaction.objectStore("pins");
  const translationCacheStore = transaction.objectStore("translationCache");
  const paperContextsStore = transaction.objectStore("paperContexts");
  const pinnedCardsStore = transaction.objectStore("pinnedTranslationCards");
  const [
    pinKeys,
    translationCacheKeys,
    pinnedCardKeys,
  ] = await Promise.all([
    pinsStore.index("by-pdf").getAllKeys(input.pdfFingerprint),
    translationCacheStore.index("by-pdf").getAllKeys(input.pdfFingerprint),
    pinnedCardsStore.index("by-pdf").getAllKeys(input.pdfFingerprint),
  ]);

  await Promise.all([
    ...pinKeys.map((key) => pinsStore.delete(key)),
    ...translationCacheKeys.map((key) => translationCacheStore.delete(key)),
    paperContextsStore.delete(input.pdfFingerprint),
    ...pinnedCardKeys.map((key) => pinnedCardsStore.delete(key)),
  ]);

  await Promise.all([
    ...input.pins.map((pin) => pinsStore.put(pin)),
    ...input.translationCacheEntries.map((entry) => translationCacheStore.put(entry)),
    input.paperContext ? paperContextsStore.put(input.paperContext) : undefined,
    ...input.pinnedTranslationCards.map((card) => pinnedCardsStore.put(card)),
  ].filter(Boolean));

  await transaction.done;
}

async function deleteAllCloudPinnedTranslationCardsByDocument(cloudDocumentId: string) {
  const now = new Date().toISOString();
  const { error } = await requireSupabaseClient()
    .from("user_pinned_translation_cards")
    .update({
      deleted_at: now,
      updated_at: now,
    })
    .eq("user_document_id", cloudDocumentId)
    .is("deleted_at", null);

  if (error) {
    throw error;
  }
}

function toIsoTime(epochMs: number | undefined) {
  return new Date(epochMs ?? Date.now()).toISOString();
}

function normalizeTranslationStylePayload<T extends {
  translationStyle?: unknown;
  translationStyleHash?: string;
}>(payload: T): T {
  return {
    ...payload,
    ...getEffectiveTranslationStyle(payload.translationStyle),
  };
}
