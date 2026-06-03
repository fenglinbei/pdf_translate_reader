export const TRANSLATION_LANGUAGES = [
  {
    code: "zh",
    label: "Simplified Chinese",
    promptLabel: "Simplified Chinese",
  },
  {
    code: "zh-Hant",
    label: "Traditional Chinese",
    promptLabel: "Traditional Chinese",
  },
  {
    code: "en",
    label: "English",
    promptLabel: "English",
  },
  {
    code: "ja",
    label: "Japanese",
    promptLabel: "Japanese",
  },
  {
    code: "ko",
    label: "Korean",
    promptLabel: "Korean",
  },
  {
    code: "fr",
    label: "French",
    promptLabel: "French",
  },
  {
    code: "de",
    label: "German",
    promptLabel: "German",
  },
  {
    code: "es",
    label: "Spanish",
    promptLabel: "Spanish",
  },
] as const;

export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number]["code"];

export const DEFAULT_SOURCE_LANG: TranslationLanguage = "en";
export const DEFAULT_TARGET_LANG: TranslationLanguage = "zh";

const TRANSLATION_LANGUAGE_CODES = new Set<string>(
  TRANSLATION_LANGUAGES.map((language) => language.code),
);

export function isTranslationLanguage(value: unknown): value is TranslationLanguage {
  return typeof value === "string" && TRANSLATION_LANGUAGE_CODES.has(value);
}

export function normalizeTranslationLanguage(
  value: unknown,
  fallback: TranslationLanguage,
): TranslationLanguage {
  const canonicalValue = normalizeLanguageAlias(value);

  return isTranslationLanguage(canonicalValue) ? canonicalValue : fallback;
}

export function normalizeTranslationLanguagePair(
  sourceInput: unknown,
  targetInput: unknown,
) {
  const sourceLang = normalizeTranslationLanguage(sourceInput, DEFAULT_SOURCE_LANG);
  const targetLang = normalizeTranslationLanguage(targetInput, DEFAULT_TARGET_LANG);

  if (sourceLang !== targetLang) {
    return { sourceLang, targetLang };
  }

  return {
    sourceLang,
    targetLang: findAlternativeLanguage(sourceLang),
  };
}

function findAlternativeLanguage(sourceLang: TranslationLanguage): TranslationLanguage {
  return TRANSLATION_LANGUAGES.find((language) => language.code !== sourceLang)?.code ?? DEFAULT_TARGET_LANG;
}

function normalizeLanguageAlias(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  const lowerValue = normalized.toLowerCase();

  if (lowerValue === "zh-hans" || lowerValue === "zh-cn" || lowerValue === "zh_cn") {
    return "zh";
  }

  if (lowerValue === "zh-hant" || lowerValue === "zh-tw" || lowerValue === "zh_tw") {
    return "zh-Hant";
  }

  return normalized;
}
