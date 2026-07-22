import { RotateCcw, Trash2 } from "lucide-react";
import { TRANSLATION_LANGUAGES } from "../config/translationLanguages";
import { useI18n } from "../i18n/I18nProvider";
import type { FreeTranslationRecord, FreeTranslationSourceLanguage } from "../types/domain";
import { getTranslationModelShortLabel } from "./models";

type FreeTranslationHistoryProps = {
  error?: string;
  isLoading: boolean;
  onClear: () => void;
  onDelete: (record: FreeTranslationRecord) => void;
  onRestore: (record: FreeTranslationRecord) => void;
  records: FreeTranslationRecord[];
};

export function FreeTranslationHistory({
  error,
  isLoading,
  onClear,
  onDelete,
  onRestore,
  records,
}: FreeTranslationHistoryProps) {
  const { t } = useI18n();

  return (
    <details className="free-translation-history">
      <summary>
        <span>{t("freeTranslation.history")}</span>
        <small>{t("freeTranslation.historyLocalOnly")}</small>
      </summary>
      <div className="free-translation-history-body">
        <div className="free-translation-history-toolbar">
          <span>{records.length}</span>
          <button
            className="free-translation-text-button"
            disabled={records.length === 0}
            onClick={onClear}
            type="button"
          >
            {t("freeTranslation.clearHistory")}
          </button>
        </div>
        {error ? <div className="free-translation-history-error">{error}</div> : null}
        {isLoading ? (
          <div className="settings-empty-row">{t("common.loading")}</div>
        ) : records.length > 0 ? (
          <div className="free-translation-history-list">
            {records.map((record) => (
              <article className="free-translation-history-item" key={record.id}>
                <button
                  className="free-translation-history-restore"
                  onClick={() => onRestore(record)}
                  title={record.sourceText}
                  type="button"
                >
                  <span className="free-translation-history-source">
                    {createPreview(record.sourceText)}
                  </span>
                  <span className="free-translation-history-meta">
                    {getLanguageLabel(record.request.sourceLang, t)} →{" "}
                    {getLanguageLabel(record.request.targetLang, t)} ·{" "}
                    {getTranslationModelShortLabel(record.request.model)} ·{" "}
                    {new Date(record.updatedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  aria-label={t("common.remove")}
                  className="icon-button icon-button--small"
                  onClick={() => onDelete(record)}
                  title={t("common.remove")}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} strokeWidth={2} />
                </button>
                <button
                  aria-label={t("common.restore")}
                  className="icon-button icon-button--small"
                  onClick={() => onRestore(record)}
                  title={t("common.restore")}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={15} strokeWidth={2} />
                </button>
              </article>
            ))}
          </div>
        ) : (
          <div className="settings-empty-row">{t("freeTranslation.historyEmpty")}</div>
        )}
      </div>
    </details>
  );
}

function createPreview(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 140);
}

function getLanguageLabel(
  language: FreeTranslationSourceLanguage,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (language === "auto") {
    return t("freeTranslation.autoDetect");
  }

  return TRANSLATION_LANGUAGES.find((item) => item.code === language)?.label ?? language;
}
