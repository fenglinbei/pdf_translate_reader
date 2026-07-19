import type { TranslationModel } from "../types/domain";

export const TRANSLATION_MODEL_OPTIONS = [
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", shortLabel: "Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", shortLabel: "Pro" },
  { id: "glm-5.2", label: "GLM 5.2", shortLabel: "GLM" },
  { id: "kimi-k3", label: "Kimi K3", shortLabel: "K3" },
] as const satisfies ReadonlyArray<{
  id: TranslationModel;
  label: string;
  shortLabel: string;
}>;

export function isTranslationModel(value: unknown): value is TranslationModel {
  return TRANSLATION_MODEL_OPTIONS.some((option) => option.id === value);
}

export function getTranslationModelShortLabel(model: TranslationModel | string | undefined) {
  return TRANSLATION_MODEL_OPTIONS.find((option) => option.id === model)?.shortLabel ?? "-";
}
