import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type {
  PaperContextRecord,
  PaperContextTerm,
  PdfLibraryEntry,
  TranslationStylePresetId,
  TranslationStyleSettings,
} from "../types/domain";
import type { MessageKey } from "../i18n/messages";
import type { PaperContextDraft } from "../translation/paperContext";
import {
  DEFAULT_TRANSLATION_STYLE,
  TRANSLATION_STYLE_CUSTOM_MAX_LENGTH,
  TRANSLATION_STYLE_PRESET_IDS,
  normalizeTranslationStyle,
} from "../translation/translationStyle";

type PaperContextEditorProps = {
  currentEntry?: PdfLibraryEntry;
  onSave: (draft: PaperContextDraft) => Promise<void> | void;
  paperContext?: PaperContextRecord;
};

type TermDraft = Pick<PaperContextTerm, "source" | "target"> & {
  id: string;
};

export function PaperContextEditor({
  currentEntry,
  onSave,
  paperContext,
}: PaperContextEditorProps) {
  const { t } = useI18n();
  const [abstract, setAbstract] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [terms, setTerms] = useState<TermDraft[]>([]);
  const [title, setTitle] = useState("");
  const [translationStyle, setTranslationStyle] =
    useState<TranslationStyleSettings>(DEFAULT_TRANSLATION_STYLE);
  const editorKey = `${currentEntry?.fingerprint ?? "none"}:${paperContext?.contextHash ?? "empty"}`;
  const canSave = Boolean(currentEntry);
  const contextSummary = useMemo(() => {
    if (!paperContext) {
      return t("paperContext.noContext");
    }

    return t("paperContext.termsSummary", {
      count: paperContext.terminology.length,
      hash: paperContext.contextHash,
    });
  }, [paperContext, t]);

  useEffect(() => {
    setAbstract(paperContext?.abstract ?? "");
    setSaveStatus("idle");
    setTerms(
      (paperContext?.terminology ?? []).map((term, index) => ({
        id: `${term.source}-${term.updatedAt}-${index}`,
        source: term.source,
        target: term.target,
      })),
    );
    setTitle(paperContext?.title ?? currentEntry?.pdfMetadata?.title ?? "");
    setTranslationStyle(normalizeTranslationStyle(paperContext?.translationStyle));
  }, [currentEntry?.fileName, currentEntry?.pdfMetadata?.title, editorKey, paperContext]);

  async function handleSave() {
    if (!canSave) {
      return;
    }

    setSaveStatus("saving");

    try {
      const now = Date.now();

      await onSave({
        abstract,
        terminology: terms.map((term, index) => ({
          confidence: "user",
          source: term.source,
          target: term.target,
          updatedAt: now + index,
        })),
        title,
        translationStyle: normalizeTranslationStyle(translationStyle),
      });
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }

  function updateTerm(termId: string, patch: Partial<TermDraft>) {
    setTerms((currentTerms) =>
      currentTerms.map((term) =>
        term.id === termId
          ? {
              ...term,
              ...patch,
            }
          : term,
      ),
    );
    setSaveStatus("idle");
  }

  return (
    <div className="paper-context-editor">
      <div className="paper-context-summary">{contextSummary}</div>
      <label className="settings-field">
        <span>{t("paperContext.title")}</span>
        <input
          disabled={!currentEntry}
          onChange={(event) => {
            setTitle(event.currentTarget.value);
            setSaveStatus("idle");
          }}
          value={title}
        />
      </label>
      <label className="settings-field">
        <span>{t("paperContext.abstract")}</span>
        <textarea
          disabled={!currentEntry}
          onChange={(event) => {
            setAbstract(event.currentTarget.value);
            setSaveStatus("idle");
          }}
          rows={4}
          value={abstract}
        />
      </label>
      <label className="settings-field">
        <span>{t("paperContext.translationStyle")}</span>
        <select
          disabled={!currentEntry}
          onChange={(event) => {
            const presetId = event.currentTarget.value as TranslationStylePresetId;

            setTranslationStyle(
              presetId === "custom"
                ? { customInstruction: "", presetId }
                : { presetId },
            );
            setSaveStatus("idle");
          }}
          value={translationStyle.presetId}
        >
          {TRANSLATION_STYLE_PRESET_IDS.map((presetId) => (
            <option key={presetId} value={presetId}>
              {t(getTranslationStylePresetLabelKey(presetId))}
            </option>
          ))}
        </select>
      </label>
      {translationStyle.presetId === "custom" ? (
        <label className="settings-field">
          <span>{t("paperContext.customTranslationStyle")}</span>
          <textarea
            disabled={!currentEntry}
            maxLength={TRANSLATION_STYLE_CUSTOM_MAX_LENGTH}
            onChange={(event) => {
              setTranslationStyle({
                customInstruction: event.currentTarget.value,
                presetId: "custom",
              });
              setSaveStatus("idle");
            }}
            rows={4}
            value={translationStyle.customInstruction ?? ""}
          />
          <small className="settings-field-hint">
            {t("paperContext.customTranslationStyleHint", {
              count: TRANSLATION_STYLE_CUSTOM_MAX_LENGTH,
            })}
          </small>
        </label>
      ) : null}
      <div className="paper-context-terms">
        <div className="paper-context-terms-header">
          <span>{t("paperContext.terminology")}</span>
          <button
            className="icon-button icon-button--small"
            disabled={!currentEntry}
            onClick={() => {
              setTerms((currentTerms) => [
                ...currentTerms,
                {
                  id: `term-${Date.now()}-${currentTerms.length}`,
                  source: "",
                  target: "",
                },
              ]);
              setSaveStatus("idle");
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
                  disabled={!currentEntry}
                  onChange={(event) => updateTerm(term.id, { source: event.currentTarget.value })}
                  placeholder={t("paperContext.source")}
                  value={term.source}
                />
                <input
                  disabled={!currentEntry}
                  onChange={(event) => updateTerm(term.id, { target: event.currentTarget.value })}
                  placeholder={t("paperContext.target")}
                  value={term.target}
                />
                <button
                  className="icon-button icon-button--small"
                  disabled={!currentEntry}
                  onClick={() => {
                    setTerms((currentTerms) => currentTerms.filter((currentTerm) => currentTerm.id !== term.id));
                    setSaveStatus("idle");
                  }}
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
      <div className="paper-context-save-row">
        <span>{formatSaveStatus(saveStatus, t)}</span>
        <button
          className="icon-button icon-button--small"
          disabled={!canSave || saveStatus === "saving"}
          onClick={() => void handleSave()}
          title={t("paperContext.save")}
          type="button"
        >
          <Save aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
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

function formatSaveStatus(
  saveStatus: "idle" | "saving" | "saved" | "error",
  t: ReturnType<typeof useI18n>["t"],
) {
  if (saveStatus === "saving") {
    return t("paperContext.saving");
  }

  if (saveStatus === "saved") {
    return t("paperContext.saved");
  }

  if (saveStatus === "error") {
    return t("paperContext.saveFailed");
  }

  return t("paperContext.manualTermsOnly");
}
