import type {
  TranslationModel,
  TranslationReasoningEffort,
} from "../types/domain";

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

export type TranslationReasoningCapability = {
  canDisable: boolean;
  defaultEnabled: boolean;
  defaultEffort: TranslationReasoningEffort;
  efforts: readonly TranslationReasoningEffort[];
};

const DEEPSEEK_REASONING_CAPABILITY: TranslationReasoningCapability = {
  canDisable: true,
  defaultEnabled: false,
  defaultEffort: "high",
  efforts: ["high", "max"],
};

const GLM_REASONING_CAPABILITY: TranslationReasoningCapability = {
  canDisable: true,
  defaultEnabled: false,
  defaultEffort: "high",
  efforts: ["high", "max"],
};

const KIMI_K3_REASONING_CAPABILITY: TranslationReasoningCapability = {
  canDisable: false,
  defaultEnabled: true,
  defaultEffort: "max",
  efforts: ["low", "high", "max"],
};

export function getTranslationReasoningCapability(
  model: TranslationModel,
): TranslationReasoningCapability {
  if (model === "kimi-k3") {
    return KIMI_K3_REASONING_CAPABILITY;
  }

  return model === "glm-5.2"
    ? GLM_REASONING_CAPABILITY
    : DEEPSEEK_REASONING_CAPABILITY;
}
