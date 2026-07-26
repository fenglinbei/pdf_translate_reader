import type { TranslationLanguage } from "../config/translationLanguages";
import type { FreeTranslationSourceLanguage } from "../types/domain";

export type FreeTranslationSwapReason =
  | "auto-source-result-not-ready"
  | "auto-source-unresolved"
  | "busy"
  | "move-translation"
  | "same-language"
  | "swap-languages"
  | "translation-too-long";

export type FreeTranslationSwapState = {
  sourceLang: FreeTranslationSourceLanguage;
  sourceText: string;
  targetLang: TranslationLanguage;
};

export type FreeTranslationSwapPlanInput = FreeTranslationSwapState & {
  busy: boolean;
  detectedSourceLang?: TranslationLanguage;
  hasFreshCompletedTranslation: boolean;
  maxSourceCharacters: number;
  translation: string;
};

export type FreeTranslationSwapPlan = {
  enabled: boolean;
  movesTranslation: boolean;
  next: FreeTranslationSwapState;
  reason: FreeTranslationSwapReason;
};

export function createFreeTranslationSwapPlan(
  input: FreeTranslationSwapPlanInput,
): FreeTranslationSwapPlan {
  const current = getCurrentState(input);

  if (input.busy) {
    return createDisabledPlan("busy", current);
  }

  const hasFreshTranslation = input.hasFreshCompletedTranslation &&
    Boolean(input.translation.trim());

  if (input.sourceLang === "auto" && !input.detectedSourceLang) {
    return createDisabledPlan("auto-source-unresolved", current);
  }

  if (input.sourceLang === "auto" && !hasFreshTranslation) {
    return createDisabledPlan("auto-source-result-not-ready", current);
  }

  const resolvedSourceLang = input.sourceLang === "auto"
    ? input.detectedSourceLang
    : input.sourceLang;

  if (!resolvedSourceLang || resolvedSourceLang === input.targetLang) {
    return createDisabledPlan("same-language", current);
  }

  if (
    hasFreshTranslation &&
    input.translation.length > input.maxSourceCharacters
  ) {
    return createDisabledPlan("translation-too-long", current);
  }

  return {
    enabled: true,
    movesTranslation: hasFreshTranslation,
    next: {
      sourceLang: input.targetLang,
      sourceText: hasFreshTranslation ? input.translation : input.sourceText,
      targetLang: resolvedSourceLang,
    },
    reason: hasFreshTranslation ? "move-translation" : "swap-languages",
  };
}

function createDisabledPlan(
  reason: Exclude<
    FreeTranslationSwapReason,
    "move-translation" | "swap-languages"
  >,
  current: FreeTranslationSwapState,
): FreeTranslationSwapPlan {
  return {
    enabled: false,
    movesTranslation: false,
    next: current,
    reason,
  };
}

function getCurrentState(
  input: FreeTranslationSwapPlanInput,
): FreeTranslationSwapState {
  return {
    sourceLang: input.sourceLang,
    sourceText: input.sourceText,
    targetLang: input.targetLang,
  };
}
