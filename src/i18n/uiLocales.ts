export const UI_LOCALES = [
  {
    code: "en-US",
    label: "English",
    nativeLabel: "English",
  },
  {
    code: "zh-CN",
    label: "Simplified Chinese",
    nativeLabel: "简体中文",
  },
] as const;

export type UiLocale = (typeof UI_LOCALES)[number]["code"];

export const DEFAULT_UI_LOCALE: UiLocale = "en-US";

const UI_LOCALE_CODES = new Set<string>(UI_LOCALES.map((locale) => locale.code));

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && UI_LOCALE_CODES.has(value);
}

export function normalizeUiLocale(value: unknown, fallback: UiLocale = DEFAULT_UI_LOCALE): UiLocale {
  const canonicalValue = normalizeUiLocaleAlias(value);

  return isUiLocale(canonicalValue) ? canonicalValue : fallback;
}

export function detectBrowserUiLocale(fallback: UiLocale = DEFAULT_UI_LOCALE): UiLocale {
  if (typeof navigator === "undefined") {
    return fallback;
  }

  const candidates = [navigator.language, ...navigator.languages];

  for (const candidate of candidates) {
    const locale = normalizeUiLocale(candidate, fallback);

    if (locale !== fallback || candidate === fallback) {
      return locale;
    }
  }

  return fallback;
}

function normalizeUiLocaleAlias(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  const lowerValue = normalized.toLowerCase().replace("_", "-");

  if (lowerValue === "zh" || lowerValue === "zh-cn" || lowerValue === "zh-hans") {
    return "zh-CN";
  }

  if (lowerValue === "en" || lowerValue === "en-us" || lowerValue === "en-gb") {
    return "en-US";
  }

  return normalized;
}
