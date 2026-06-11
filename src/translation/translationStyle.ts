import type {
  TranslationStylePresetId,
  TranslationStyleSettings,
} from "../types/domain";

export const TRANSLATION_STYLE_CUSTOM_MAX_LENGTH = 800;

export const TRANSLATION_STYLE_PRESET_IDS = [
  "academic-faithful",
  "academic-fluent",
  "concise-literal",
  "publication-polished",
  "reader-friendly",
  "custom",
] as const satisfies TranslationStylePresetId[];

export const DEFAULT_TRANSLATION_STYLE: TranslationStyleSettings = {
  presetId: "academic-faithful",
};

export function normalizeTranslationStyle(input: unknown): TranslationStyleSettings {
  const value = isRecord(input) ? input : {};
  const presetId = isTranslationStylePresetId(value.presetId)
    ? value.presetId
    : DEFAULT_TRANSLATION_STYLE.presetId;

  if (presetId !== "custom") {
    return { presetId };
  }

  const customInstruction = cleanOptionalText(value.customInstruction, TRANSLATION_STYLE_CUSTOM_MAX_LENGTH);

  if (!customInstruction) {
    return DEFAULT_TRANSLATION_STYLE;
  }

  return {
    customInstruction,
    presetId,
  };
}

export function getTranslationStyleHash(input: unknown) {
  return `style-${hashString(JSON.stringify(normalizeTranslationStyle(input)))}`;
}

export function getEffectiveTranslationStyle(input: unknown) {
  const translationStyle = normalizeTranslationStyle(input);

  return {
    translationStyle,
    translationStyleHash: getTranslationStyleHash(translationStyle),
  };
}

function isTranslationStylePresetId(value: unknown): value is TranslationStylePresetId {
  return typeof value === "string" &&
    TRANSLATION_STYLE_PRESET_IDS.includes(value as TranslationStylePresetId);
}

function cleanOptionalText(value: unknown, maxLength: number) {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, maxLength).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function hashString(value: string) {
  let hash = 5381;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}
