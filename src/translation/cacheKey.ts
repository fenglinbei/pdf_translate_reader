import type { SourceLanguage, TargetLanguage, TranslationModel } from "../types/domain";

export type TranslationCacheKeyInput = {
  pdfFingerprint: string;
  normalizedSentence: string;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  model: TranslationModel;
  contextWindowN: number;
  longContextEnabled: boolean;
  paperContextHash?: string;
  promptVersion: string;
};

export function createTranslationCacheKey(input: TranslationCacheKeyInput) {
  return JSON.stringify({
    pdfFingerprint: input.pdfFingerprint,
    normalizedSentence: input.normalizedSentence,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    model: input.model,
    contextWindowN: input.contextWindowN,
    longContextEnabled: input.longContextEnabled,
    paperContextHash: input.paperContextHash ?? "",
    promptVersion: input.promptVersion,
  });
}
