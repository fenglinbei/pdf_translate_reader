import { getAppDb } from "../cache";
import {
  deleteCloudPinnedTranslationCard,
  syncPinnedTranslationCardToCloud,
} from "../cloud/documentStateRepository";
import { runCloudSync } from "../cloud/syncStatus";
import type {
  PinnedTranslationCard,
  StoredPinnedTranslationCard,
} from "./floatingCardTypes";

export async function listPinnedTranslationCardsByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const records = await db.getAllFromIndex("pinnedTranslationCards", "by-pdf", pdfFingerprint);

  return records
    .sort(compareStoredPinnedTranslationCards)
    .map(stripStoredFields);
}

export async function putPinnedTranslationCard(card: PinnedTranslationCard) {
  const db = await getAppDb();
  const existing = await db.get("pinnedTranslationCards", card.key);
  const now = Date.now();
  const record: StoredPinnedTranslationCard = {
    ...card,
    cloudDocumentId: card.cloudDocumentId ?? card.selection.cloudDocumentId,
    createdAt: existing?.createdAt ?? now,
    pdfFingerprint: card.selection.pdfFingerprint,
    updatedAt: now,
  };

  await db.put("pinnedTranslationCards", record);
  await runCloudSync(() => syncPinnedTranslationCardToCloud(record), {
    error: "Saved pinned translation card locally, but cloud sync failed.",
    started: "Syncing pinned translation card.",
    success: "Pinned translation card synced.",
  }).catch(() => undefined);

  return stripStoredFields(record);
}

export async function deletePinnedTranslationCard(cardKey: string, cloudDocumentId?: string) {
  const db = await getAppDb();
  const existing = await db.get("pinnedTranslationCards", cardKey);

  await db.delete("pinnedTranslationCards", cardKey);
  await runCloudSync(
    () => deleteCloudPinnedTranslationCard(
      cloudDocumentId ?? existing?.cloudDocumentId,
      cardKey,
    ),
    {
      error: "Removed pinned translation card locally, but cloud sync failed.",
      started: "Syncing pinned translation card removal.",
      success: "Pinned translation card removal synced.",
    },
  ).catch(() => undefined);
}

function stripStoredFields(record: StoredPinnedTranslationCard): PinnedTranslationCard {
  const {
    cloudDocumentId,
    createdAt: _createdAt,
    pdfFingerprint: _pdfFingerprint,
    updatedAt: _updatedAt,
    ...card
  } = record;

  return {
    ...card,
    cloudDocumentId,
  };
}

function compareStoredPinnedTranslationCards(
  left: StoredPinnedTranslationCard,
  right: StoredPinnedTranslationCard,
) {
  if (left.zIndex !== right.zIndex) {
    return left.zIndex - right.zIndex;
  }

  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt - right.updatedAt;
  }

  return left.key.localeCompare(right.key);
}
