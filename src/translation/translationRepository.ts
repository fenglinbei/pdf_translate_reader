import type {
  SourceLanguage,
  TargetLanguage,
  TextExtractionSource,
  TokenUsage,
  TranslationCacheEntry,
  TranslationModel,
  TranslationStyleSettings,
} from "../types/domain";
import { getAppDb } from "../cache";
import {
  deleteAllCloudTranslationCache,
  deleteCloudTranslationCacheByDocument,
  syncTranslationCacheToCloud,
} from "../cloud/documentStateRepository";
import { runCloudSync } from "../cloud/syncStatus";

export type TranslationCacheWriteInput = {
  cacheKey: string;
  cloudDocumentId?: string;
  pdfFingerprint: string;
  normalizedSentence: string;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  textSource?: TextExtractionSource;
  mathpixOptionsHash?: string;
  model: TranslationModel;
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
  translationStyle: TranslationStyleSettings;
  translationStyleHash: string;
  translation: string;
  usage?: TokenUsage;
};

export async function getTranslationCacheEntry(cacheKey: string) {
  const db = await getAppDb();

  return db.get("translationCache", cacheKey);
}

export async function putTranslationCacheEntry(input: TranslationCacheWriteInput) {
  const db = await getAppDb();
  const existing = await db.get("translationCache", input.cacheKey);
  const now = Date.now();
  const entry: TranslationCacheEntry = {
    cacheKey: input.cacheKey,
    cloudDocumentId: input.cloudDocumentId,
    pdfFingerprint: input.pdfFingerprint,
    normalizedSentence: input.normalizedSentence,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    textSource: input.textSource,
    mathpixOptionsHash: input.mathpixOptionsHash,
    model: input.model,
    contextWindowN: input.contextWindowN,
    longContextEnabled: input.longContextEnabled,
    paperContextHash: input.paperContextHash,
    promptVersion: input.promptVersion,
    translationStyle: input.translationStyle,
    translationStyleHash: input.translationStyleHash,
    translation: input.translation,
    usage: input.usage,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db.put("translationCache", entry);
  await runCloudSync(() => syncTranslationCacheToCloud(entry), {
    error: "Saved translation locally, but cloud cache sync failed.",
    started: "Syncing translation cache.",
    success: "Translation cache synced.",
  }).catch(() => undefined);

  return entry;
}

export async function clearTranslationCache() {
  const db = await getAppDb();

  await db.clear("translationCache");
  await runCloudSync(() => deleteAllCloudTranslationCache(), {
    error: "Cleared translation cache locally, but cloud sync failed.",
    started: "Syncing translation cache clear.",
    success: "Translation cache clear synced.",
  }).catch(() => undefined);
}

export async function deleteTranslationCacheEntriesByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const entries = await db.getAllFromIndex("translationCache", "by-pdf", pdfFingerprint);
  const keys = await db.getAllKeysFromIndex("translationCache", "by-pdf", pdfFingerprint);
  const cloudDocumentIds = Array.from(
    new Set(entries.map((entry) => entry.cloudDocumentId).filter(Boolean)),
  );

  await Promise.all(keys.map((key) => db.delete("translationCache", key)));
  await runCloudSync(
    () => Promise.all(
      cloudDocumentIds.map((cloudDocumentId) => deleteCloudTranslationCacheByDocument(cloudDocumentId)),
    ),
    {
      error: "Deleted translation cache locally, but cloud sync failed.",
      started: "Syncing translation cache deletion.",
      success: "Translation cache deletion synced.",
    },
  ).catch(() => undefined);
}
