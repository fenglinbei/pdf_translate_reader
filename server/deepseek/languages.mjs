export const TRANSLATION_LANGUAGES = [
  {
    code: "zh",
    promptLabel: "Simplified Chinese",
  },
  {
    code: "zh-Hant",
    promptLabel: "Traditional Chinese",
  },
  {
    code: "en",
    promptLabel: "English",
  },
  {
    code: "ja",
    promptLabel: "Japanese",
  },
  {
    code: "ko",
    promptLabel: "Korean",
  },
  {
    code: "fr",
    promptLabel: "French",
  },
  {
    code: "de",
    promptLabel: "German",
  },
  {
    code: "es",
    promptLabel: "Spanish",
  },
];

const LANGUAGE_BY_CODE = new Map(
  TRANSLATION_LANGUAGES.map((language) => [language.code, language]),
);

export function parseTranslationLanguage(value, fieldName) {
  const canonicalValue = normalizeLanguageAlias(value);

  if (LANGUAGE_BY_CODE.has(canonicalValue)) {
    return canonicalValue;
  }

  throw new Error(
    `Unsupported ${fieldName}: ${String(value)}. Supported languages: ${getSupportedTranslationLanguageCodes().join(", ")}.`,
  );
}

export function normalizeTranslationLanguagePair(sourceInput, targetInput) {
  const sourceLang = parseTranslationLanguage(sourceInput, "sourceLang");
  const targetLang = parseTranslationLanguage(targetInput, "targetLang");

  if (sourceLang === targetLang) {
    throw new Error("Source and target languages must be different.");
  }

  return { sourceLang, targetLang };
}

export function getTranslationLanguagePromptLabel(code) {
  return LANGUAGE_BY_CODE.get(code)?.promptLabel ?? code;
}

export function getSupportedTranslationLanguageCodes() {
  return TRANSLATION_LANGUAGES.map((language) => language.code);
}

function normalizeLanguageAlias(value) {
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
