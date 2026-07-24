import { Plus, Trash2 } from "lucide-react";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import type {
  TranslationModel,
  TranslationReasoningEffort,
  TranslationStylePresetId,
  TranslationStyleSettings,
} from "../types/domain";
import {
  getTranslationReasoningCapability,
  TRANSLATION_MODEL_OPTIONS,
} from "./models";
import {
  TRANSLATION_STYLE_CUSTOM_MAX_LENGTH,
  TRANSLATION_STYLE_PRESET_IDS,
} from "./translationStyle";

export type FreeTranslationTermDraft = {
  id: string;
  source: string;
  target: string;
};

type FreeTranslationOptionsProps = {
  disabled: boolean;
  hasPaperContext: boolean;
  includePaperContext: boolean;
  model: TranslationModel;
  onIncludePaperContextChange: (enabled: boolean) => void;
  onModelChange: (model: TranslationModel) => void;
  onReasoningEffortChange: (effort: TranslationReasoningEffort) => void;
  onReasoningEnabledChange: (enabled: boolean) => void;
  setTerms: Dispatch<SetStateAction<FreeTranslationTermDraft[]>>;
  terms: FreeTranslationTermDraft[];
  reasoningEffort: TranslationReasoningEffort;
  reasoningEnabled: boolean;
  translationStyle: TranslationStyleSettings;
  onTranslationStyleChange: (style: TranslationStyleSettings) => void;
};

export function FreeTranslationOptions({
  disabled,
  hasPaperContext,
  includePaperContext,
  model,
  onIncludePaperContextChange,
  onModelChange,
  onReasoningEffortChange,
  onReasoningEnabledChange,
  onTranslationStyleChange,
  reasoningEffort,
  reasoningEnabled,
  setTerms,
  terms,
  translationStyle,
}: FreeTranslationOptionsProps) {
  const { t } = useI18n();
  const reasoningCapability = getTranslationReasoningCapability(model);
  const effectiveReasoningEnabled = !reasoningCapability.canDisable || reasoningEnabled;
  const effectiveReasoningEffort = reasoningCapability.efforts.includes(reasoningEffort)
    ? reasoningEffort
    : reasoningCapability.defaultEffort;

  useEffect(() => {
    if (effectiveReasoningEffort !== reasoningEffort) {
      onReasoningEffortChange(effectiveReasoningEffort);
    }
  }, [
    effectiveReasoningEffort,
    onReasoningEffortChange,
    reasoningEffort,
  ]);

  function updateTerm(termId: string, patch: Partial<FreeTranslationTermDraft>) {
    setTerms((currentTerms) =>
      currentTerms.map((term) => term.id === termId ? { ...term, ...patch } : term),
    );
  }

  return (
    <details className="free-translation-advanced">
      <summary>{t("freeTranslation.advancedOptions")}</summary>
      <fieldset className="free-translation-options-grid" disabled={disabled}>
        <label className="settings-field">
          <span>{t("settings.defaultModel")}</span>
          <select
            value={model}
            onChange={(event) => onModelChange(event.currentTarget.value as TranslationModel)}
          >
            {TRANSLATION_MODEL_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="settings-toggle free-translation-context-toggle">
          <input
            checked={includePaperContext && hasPaperContext}
            disabled={!hasPaperContext || disabled}
            onChange={(event) => onIncludePaperContextChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{t("freeTranslation.includePaperContext")}</span>
        </label>

        <div className="free-translation-reasoning-options">
          <label className="settings-toggle">
            <input
              checked={effectiveReasoningEnabled}
              disabled={disabled || !reasoningCapability.canDisable}
              onChange={(event) => onReasoningEnabledChange(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>{t("freeTranslation.reasoningEnabled")}</span>
          </label>
          <small className="settings-field-hint">
            {reasoningCapability.canDisable
              ? t("freeTranslation.reasoningHint")
              : t("freeTranslation.reasoningRequiredHint")}
          </small>
        </div>

        <label className="settings-field">
          <span>{t("freeTranslation.reasoningEffort")}</span>
          <select
            disabled={disabled || !effectiveReasoningEnabled}
            onChange={(event) => onReasoningEffortChange(
              event.currentTarget.value as TranslationReasoningEffort,
            )}
            value={effectiveReasoningEffort}
          >
            {reasoningCapability.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {t(getReasoningEffortLabelKey(effort))}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>{t("paperContext.translationStyle")}</span>
          <select
            value={translationStyle.presetId}
            onChange={(event) => {
              const presetId = event.currentTarget.value as TranslationStylePresetId;
              onTranslationStyleChange(
                presetId === "custom" ? { customInstruction: "", presetId } : { presetId },
              );
            }}
          >
            {TRANSLATION_STYLE_PRESET_IDS.map((presetId) => (
              <option key={presetId} value={presetId}>
                {t(getTranslationStylePresetLabelKey(presetId))}
              </option>
            ))}
          </select>
        </label>

        {translationStyle.presetId === "custom" ? (
          <label className="settings-field free-translation-custom-style">
            <span>{t("paperContext.customTranslationStyle")}</span>
            <textarea
              maxLength={TRANSLATION_STYLE_CUSTOM_MAX_LENGTH}
              onChange={(event) => onTranslationStyleChange({
                customInstruction: event.currentTarget.value,
                presetId: "custom",
              })}
              rows={3}
              value={translationStyle.customInstruction ?? ""}
            />
            <small className="settings-field-hint">
              {t("paperContext.customTranslationStyleHint", {
                count: TRANSLATION_STYLE_CUSTOM_MAX_LENGTH,
              })}
            </small>
          </label>
        ) : null}

        <div className="paper-context-terms free-translation-terms">
          <div className="paper-context-terms-header">
            <span>{t("paperContext.terminology")}</span>
            <button
              className="icon-button icon-button--small"
              onClick={() => {
                setTerms((currentTerms) => [
                  ...currentTerms,
                  {
                    id: `free-term-${Date.now()}-${currentTerms.length}`,
                    source: "",
                    target: "",
                  },
                ]);
              }}
              title={t("paperContext.addTerm")}
              type="button"
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          </div>
          {terms.length > 0 ? (
            <div className="paper-context-term-list">
              {terms.map((term) => (
                <div className="paper-context-term-row" key={term.id}>
                  <input
                    onChange={(event) => updateTerm(term.id, { source: event.currentTarget.value })}
                    placeholder={t("paperContext.source")}
                    value={term.source}
                  />
                  <input
                    onChange={(event) => updateTerm(term.id, { target: event.currentTarget.value })}
                    placeholder={t("paperContext.target")}
                    value={term.target}
                  />
                  <button
                    className="icon-button icon-button--small"
                    onClick={() => setTerms((currentTerms) =>
                      currentTerms.filter((item) => item.id !== term.id)
                    )}
                    title={t("paperContext.removeTerm")}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="settings-empty-row">{t("paperContext.noTerms")}</div>
          )}
        </div>
      </fieldset>
    </details>
  );
}

function getReasoningEffortLabelKey(
  effort: TranslationReasoningEffort,
): MessageKey {
  switch (effort) {
    case "low":
      return "freeTranslation.reasoningEffortLow";
    case "max":
      return "freeTranslation.reasoningEffortMax";
    case "high":
    default:
      return "freeTranslation.reasoningEffortHigh";
  }
}

function getTranslationStylePresetLabelKey(presetId: TranslationStylePresetId): MessageKey {
  switch (presetId) {
    case "academic-fluent":
      return "translationStyle.academicFluent";
    case "concise-literal":
      return "translationStyle.conciseLiteral";
    case "publication-polished":
      return "translationStyle.publicationPolished";
    case "reader-friendly":
      return "translationStyle.readerFriendly";
    case "custom":
      return "translationStyle.custom";
    case "academic-faithful":
    default:
      return "translationStyle.academicFaithful";
  }
}
