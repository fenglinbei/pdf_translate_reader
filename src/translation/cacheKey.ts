import type {
  SourceLanguage,
  TargetLanguage,
  TextExtractionSource,
  TranslationModel,
} from "../types/domain";

export type TranslationCacheKeyInput = {
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
};

export function createTranslationCacheKey(input: TranslationCacheKeyInput) {
  return JSON.stringify({
    pdfFingerprint: input.pdfFingerprint,
    normalizedSentence: input.normalizedSentence,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    textSource: input.textSource ?? "pdfjs",
    mathpixOptionsHash: input.mathpixOptionsHash ?? "",
    model: input.model,
    contextWindowN: input.contextWindowN,
    longContextEnabled: input.longContextEnabled,
    paperContextHash: input.paperContextHash ?? "",
    promptVersion: input.promptVersion,
  });
}
