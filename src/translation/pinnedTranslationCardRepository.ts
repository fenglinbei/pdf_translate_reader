import { getAppDb } from "../cache";
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
    createdAt: existing?.createdAt ?? now,
    pdfFingerprint: card.selection.pdfFingerprint,
    updatedAt: now,
  };

  await db.put("pinnedTranslationCards", record);

  return stripStoredFields(record);
}

export async function deletePinnedTranslationCard(cardKey: string) {
  const db = await getAppDb();

  await db.delete("pinnedTranslationCards", cardKey);
}

function stripStoredFields(record: StoredPinnedTranslationCard): PinnedTranslationCard {
  const {
    createdAt: _createdAt,
    pdfFingerprint: _pdfFingerprint,
    updatedAt: _updatedAt,
    ...card
  } = record;

  return card;
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
