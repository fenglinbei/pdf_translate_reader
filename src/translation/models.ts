import {
  getAvailableModelIds,
  getModelDefinition,
  isAvailableModel,
  isKnownModel,
  MODEL_DEFAULTS,
  requireModelDefinition,
} from "../../shared/modelRegistry.mjs";
import type { TranslationModel } from "../types/domain";

export {
  getTranslationReasoningCapability,
  type TranslationReasoningCapability,
} from "../../shared/modelRegistry.mjs";

export const DEFAULT_TRANSLATION_MODEL = MODEL_DEFAULTS.translation;
export const TRANSLATION_MODEL_OPTIONS = getAvailableModelIds("translation").map((id) => {
  const model = requireModelDefinition(id);
  return { id, label: model.label, shortLabel: model.shortLabel };
});

export function isTranslationModel(value: unknown): value is TranslationModel {
  return isKnownModel(value, "translation");
}

export function isSelectableTranslationModel(value: unknown): value is TranslationModel {
  return isAvailableModel(value, "translation");
}

export function getTranslationModelShortLabel(model: TranslationModel | string | undefined) {
  return getModelDefinition(model)?.shortLabel ?? "-";
}
