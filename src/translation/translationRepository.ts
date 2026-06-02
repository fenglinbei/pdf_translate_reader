import type { TokenUsage, TranslationCacheEntry, TranslationModel } from "../types/domain";
import { getAppDb } from "../cache";

export type TranslationCacheWriteInput = {
  cacheKey: string;
  pdfFingerprint: string;
  normalizedSentence: string;
  sourceLang: "en";
  targetLang: "zh";
  model: TranslationModel;
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
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
    pdfFingerprint: input.pdfFingerprint,
    normalizedSentence: input.normalizedSentence,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    model: input.model,
    contextWindowN: input.contextWindowN,
    longContextEnabled: input.longContextEnabled,
    paperContextHash: input.paperContextHash,
    promptVersion: input.promptVersion,
    translation: input.translation,
    usage: input.usage,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await db.put("translationCache", entry);

  return entry;
}
