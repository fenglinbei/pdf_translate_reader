import { useCallback, useEffect, useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import {
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "../config/translationLanguages";
import { useI18n } from "../i18n/I18nProvider";
import { UI_LOCALES, type UiLocale } from "../i18n/uiLocales";
import type {
  AppSettings,
  CloudPdfLibraryEntry,
  PaperContextRecord,
  PdfLibraryEntry,
} from "../types/domain";
import { PaperContextEditor } from "./PaperContextEditor";
import { API_LOGS_UPDATED_EVENT } from "../translation/apiLogRepository";
import {
  getApiUsageSummary,
  MAX_DRAGGED_WORDS_LIMIT,
  MIN_DRAGGED_WORDS_LIMIT,
  type ApiUsageSummary,
} from "./settingsRepository";
import type { PaperContextDraft } from "../translation/paperContext";

type SettingsPanelProps = {
  apiKeyConfigured?: boolean;
  apiStatus: "checking" | "offline" | "online";
  currentEntry?: PdfLibraryEntry;
  libraryEntries: CloudPdfLibraryEntry[];
  onClearCurrentPdfData: () => Promise<void>;
  onClearCurrentPdfPins: () => Promise<void>;
  onClearTranslationCache: () => Promise<void>;
  onClose: () => void;
  onDeletePdfData: (entry: CloudPdfLibraryEntry) => Promise<void>;
  onPaperContextSave: (draft: PaperContextDraft) => Promise<void> | void;
  onSettingsChange: (settings: Partial<AppSettings>) => Promise<void> | void;
  paperContext?: PaperContextRecord;
  settings: AppSettings;
  supabaseConfigured?: boolean;
};

type PendingAction =
  | "clear-cache"
  | "clear-current-pdf"
  | "clear-current-pins"
  | `delete-pdf:${string}`;

const EMPTY_USAGE_SUMMARY: ApiUsageSummary = {
  abortedCalls: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  completionTokens: 0,
  errorCalls: 0,
  modelCounts: {
    "deepseek-v4-flash": 0,
    "deepseek-v4-pro": 0,
  },
  promptTokens: 0,
  recentLogs: [],
  successfulCalls: 0,
  totalCalls: 0,
  totalTokens: 0,
};

export function SettingsPanel({
  apiKeyConfigured,
  apiStatus,
  currentEntry,
  libraryEntries,
  onClearCurrentPdfData,
  onClearCurrentPdfPins,
  onClearTranslationCache,
  onClose,
  onDeletePdfData,
  onPaperContextSave,
  onSettingsChange,
  paperContext,
  settings,
  supabaseConfigured,
}: SettingsPanelProps) {
  const { formatNumber: formatLocalizedNumber, t } = useI18n();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [statusMessage, setStatusMessage] = useState<string>();
  const [usageSummary, setUsageSummary] = useState<ApiUsageSummary>(EMPTY_USAGE_SUMMARY);

  const refreshUsageSummary = useCallback(() => {
    void getApiUsageSummary({
      cloudDocumentId: currentEntry?.cloudDocumentId,
      pdfFingerprint: currentEntry?.fingerprint,
    })
      .then(setUsageSummary)
      .catch(() => {
        setUsageSummary(EMPTY_USAGE_SUMMARY);
      });
  }, [currentEntry?.cloudDocumentId, currentEntry?.fingerprint]);

  useEffect(() => {
    refreshUsageSummary();
  }, [refreshUsageSummary]);

  useEffect(() => {
    window.addEventListener(API_LOGS_UPDATED_EVENT, refreshUsageSummary);

    return () => {
      window.removeEventListener(API_LOGS_UPDATED_EVENT, refreshUsageSummary);
    };
  }, [refreshUsageSummary]);

  const updateSettings = useCallback(
    async (nextSettings: Partial<AppSettings>) => {
      try {
        setStatusMessage(undefined);
        await onSettingsChange(nextSettings);
      } catch {
        setStatusMessage(t("settings.saveFailed"));
      }
    },
    [onSettingsChange, t],
  );

  const runConfirmedAction = useCallback(
    async (action: PendingAction, callback: () => Promise<void>, message: string) => {
      if (pendingAction !== action) {
        setPendingAction(action);
        setStatusMessage(t("settings.confirmAction"));
        return;
      }

      try {
        setStatusMessage(undefined);
        await callback();
        setPendingAction(undefined);
        setStatusMessage(message);
        refreshUsageSummary();
      } catch {
        setStatusMessage(t("settings.actionFailed"));
      }
    },
    [pendingAction, refreshUsageSummary, t],
  );

  const handleSourceLanguageChange = useCallback(
    (sourceLang: TranslationLanguage) => {
      void updateSettings({
        sourceLang,
        targetLang: sourceLang === settings.targetLang ? settings.sourceLang : settings.targetLang,
      });
    },
    [settings.sourceLang, settings.targetLang, updateSettings],
  );

  const handleTargetLanguageChange = useCallback(
    (targetLang: TranslationLanguage) => {
      void updateSettings({
        sourceLang: targetLang === settings.sourceLang ? settings.targetLang : settings.sourceLang,
        targetLang,
      });
    },
    [settings.sourceLang, settings.targetLang, updateSettings],
  );

  return (
    <div
      className="settings-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <aside className="settings-panel" aria-label={t("settings.title")}>
        <header className="settings-panel-header">
          <div>
            <div className="settings-panel-title">{t("settings.title")}</div>
            <div className="settings-panel-subtitle">{t("settings.localPreferences")}</div>
          </div>
          <button className="icon-button" onClick={onClose} title={t("settings.close")} type="button">
            <X aria-hidden="true" size={18} strokeWidth={2} />
          </button>
        </header>

        {statusMessage ? <div className="settings-panel-status">{statusMessage}</div> : null}

        <section className="settings-section" aria-label={t("settings.interfaceLanguage")}>
          <div className="settings-section-heading">{t("settings.interfaceLanguage")}</div>
          <label className="settings-field">
            <span>{t("settings.interfaceLanguage")}</span>
            <select
              value={settings.uiLocale}
              onChange={(event) =>
                void updateSettings({
                  uiLocale: event.currentTarget.value as UiLocale,
                })
              }
            >
              {UI_LOCALES.map((locale) => (
                <option key={locale.code} value={locale.code}>
                  {locale.nativeLabel}
                </option>
              ))}
            </select>
          </label>
        </section>

        <section className="settings-section" aria-label={t("settings.translationSettings")}>
          <div className="settings-section-heading">{t("settings.translation")}</div>
          <div className="settings-field-grid">
            <label className="settings-field">
              <span>{t("settings.source")}</span>
              <select
                value={settings.sourceLang}
                onChange={(event) =>
                  handleSourceLanguageChange(event.currentTarget.value as TranslationLanguage)
                }
              >
                {TRANSLATION_LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field">
              <span>{t("settings.target")}</span>
              <select
                value={settings.targetLang}
                onChange={(event) =>
                  handleTargetLanguageChange(event.currentTarget.value as TranslationLanguage)
                }
              >
                {TRANSLATION_LANGUAGES.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="settings-field">
            <span>{t("settings.defaultModel")}</span>
            <select
              value={settings.defaultModel}
              onChange={(event) =>
                void updateSettings({
                  defaultModel: event.currentTarget.value as AppSettings["defaultModel"],
                })
              }
            >
              <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
              <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            </select>
          </label>
          <label className="settings-field">
            <span>{t("settings.contextWindow")}</span>
            <select
              value={settings.contextWindowN}
              onChange={(event) =>
                void updateSettings({
                  contextWindowN: Number(event.currentTarget.value) as AppSettings["contextWindowN"],
                })
              }
            >
              {[0, 1, 2, 3, 5].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-toggle">
            <input
              checked={settings.longContextEnabled}
              onChange={(event) =>
                void updateSettings({
                  longContextEnabled: event.currentTarget.checked,
                })
              }
              type="checkbox"
            />
            <span>{t("settings.longContext")}</span>
          </label>
        </section>

        <section className="settings-section" aria-label={t("settings.selectionSettings")}>
          <div className="settings-section-heading">{t("settings.selection")}</div>
          <label className="settings-field">
            <span>{t("settings.textSelectionMode")}</span>
            <select
              value={settings.textSelectionMode}
              onChange={(event) =>
                void updateSettings({
                  textSelectionMode: event.currentTarget.value as AppSettings["textSelectionMode"],
                })
              }
            >
              <option value="mathpix">{t("settings.textSelectionModeMathpix")}</option>
              <option value="original">{t("settings.textSelectionModeOriginal")}</option>
            </select>
            <small className="settings-field-hint">{t("settings.textSelectionModeHint")}</small>
          </label>
          <label className="settings-field">
            <span>{t("settings.selectedTextOutputMode")}</span>
            <select
              value={settings.selectedTextOutputMode}
              onChange={(event) =>
                void updateSettings({
                  selectedTextOutputMode: event.currentTarget.value as AppSettings["selectedTextOutputMode"],
                })
              }
            >
              <option value="processed">{t("settings.selectedTextOutputModeProcessed")}</option>
              <option value="native">{t("settings.selectedTextOutputModeNative")}</option>
            </select>
            <small className="settings-field-hint">{t("settings.selectedTextOutputModeHint")}</small>
          </label>
          <label className="settings-field">
            <span>{t("settings.draggedWords")}</span>
            <input
              max={MAX_DRAGGED_WORDS_LIMIT}
              min={MIN_DRAGGED_WORDS_LIMIT}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);

                if (Number.isFinite(value)) {
                  void updateSettings({ maxDraggedWords: value });
                }
              }}
              step={1}
              type="number"
              value={settings.maxDraggedWords}
            />
            <small className="settings-field-hint">
              {t("settings.maxWordsHint", { count: MAX_DRAGGED_WORDS_LIMIT })}
            </small>
          </label>
        </section>

        <section className="settings-section" aria-label={t("settings.paperContext")}>
          <div className="settings-section-heading">{t("settings.paperContext")}</div>
          <PaperContextEditor
            currentEntry={currentEntry}
            onSave={onPaperContextSave}
            paperContext={paperContext}
          />
        </section>

        <section className="settings-section" aria-label={t("settings.api")}>
          <div className="settings-section-heading">{t("settings.api")}</div>
          <div className="settings-readout-list">
            <Readout label={t("settings.status")} value={apiStatus} />
            <Readout
              label={t("settings.apiKey")}
              value={apiKeyConfigured === undefined ? "-" : apiKeyConfigured ? t("common.configured") : t("common.missing")}
            />
            <Readout
              label={t("settings.supabase")}
              value={supabaseConfigured === undefined ? "-" : supabaseConfigured ? t("common.configured") : t("common.missing")}
            />
            <Readout label={t("settings.calls")} value={formatLocalizedNumber(usageSummary.totalCalls)} />
            <Readout label={t("settings.errors")} value={formatLocalizedNumber(usageSummary.errorCalls)} />
            <Readout label={t("settings.tokens")} value={formatLocalizedNumber(usageSummary.totalTokens)} />
            <Readout
              label={t("settings.models")}
              value={`F ${usageSummary.modelCounts["deepseek-v4-flash"]} / P ${usageSummary.modelCounts["deepseek-v4-pro"]}`}
            />
            <Readout label={t("settings.dsCacheHit")} value={formatLocalizedNumber(usageSummary.cacheHitTokens)} />
            <Readout label={t("settings.dsCacheMiss")} value={formatLocalizedNumber(usageSummary.cacheMissTokens)} />
          </div>
          <div className="settings-log-list" aria-label={t("settings.recentApiCalls")}>
            {usageSummary.recentLogs.length > 0
              ? usageSummary.recentLogs.map((log) => (
                  <div className="settings-log-row" key={log.id}>
                    <span>{log.model === "deepseek-v4-pro" ? "Pro" : "Flash"}</span>
                    <span>{log.status}</span>
                    <span>{formatDuration(log)}</span>
                    <span>{formatLocalizedNumber(log.totalTokens ?? 0)}</span>
                  </div>
                ))
              : <div className="settings-empty-row">{t("settings.noApiCalls")}</div>}
          </div>
        </section>

        <section className="settings-section" aria-label={t("settings.libraryDataManagement")}>
          <div className="settings-section-heading">{t("settings.libraryData")}</div>
          <div className="settings-action-list">
            <ConfirmButton
              disabled={false}
              isPending={pendingAction === "clear-cache"}
              label={t("settings.clearTranslationCache")}
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-cache",
                  onClearTranslationCache,
                  t("settings.translationCacheCleared"),
                )
              }
            />
            <ConfirmButton
              disabled={!currentEntry}
              isPending={pendingAction === "clear-current-pdf"}
              label={t("settings.clearCurrentPdfData")}
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-current-pdf",
                  onClearCurrentPdfData,
                  t("settings.currentPdfDataCleared"),
                )
              }
            />
            <ConfirmButton
              disabled={!currentEntry}
              isPending={pendingAction === "clear-current-pins"}
              label={t("settings.clearCurrentPdfAnnotations")}
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-current-pins",
                  onClearCurrentPdfPins,
                  t("settings.currentPdfAnnotationsCleared"),
                )
              }
            />
          </div>
        </section>

        <section className="settings-section" aria-label={t("settings.pdfHistory")}>
          <div className="settings-section-heading">{t("settings.pdfHistory")}</div>
          <div className="settings-history-list">
            {libraryEntries.length > 0
              ? libraryEntries.map((entry) => {
                  const actionId = `delete-pdf:${entry.cloudDocumentId}` as const;

                  return (
                    <div className="settings-history-row" key={entry.fingerprint}>
                      <div className="settings-history-main">
                        <div className="settings-history-title">{entry.pdfMetadata?.title || entry.fileName}</div>
                        <div className="settings-history-meta">
                          {formatBytes(entry.fileSize)} · {t("settings.opens", { count: entry.openCount })}
                        </div>
                      </div>
                      {pendingAction === actionId ? (
                        <div className="settings-confirm-actions">
                          <button
                            className="icon-button icon-button--small icon-button--success"
                            onClick={() =>
                              void runConfirmedAction(
                                actionId,
                                () => onDeletePdfData(entry),
                                t("settings.pdfDataRemoved"),
                              )
                            }
                            title={t("settings.removePdfDataConfirm")}
                            type="button"
                          >
                            <Check aria-hidden="true" size={16} strokeWidth={2} />
                          </button>
                          <button
                            className="icon-button icon-button--small icon-button--danger"
                            onClick={() => setPendingAction(undefined)}
                            title={t("common.cancel")}
                            type="button"
                          >
                            <X aria-hidden="true" size={16} strokeWidth={2} />
                          </button>
                        </div>
                      ) : (
                        <button
                          className="icon-button icon-button--small"
                          onClick={() => {
                            setPendingAction(actionId);
                            setStatusMessage(t("settings.confirmAction"));
                          }}
                          title={t("settings.removePdfData")}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  );
                })
              : <div className="settings-empty-row">{t("settings.noPdfs")}</div>}
          </div>
        </section>
      </aside>
    </div>
  );
}

function ConfirmButton({
  disabled,
  isPending,
  label,
  onCancel,
  onConfirm,
}: {
  disabled: boolean;
  isPending: boolean;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="settings-action-row">
      <span>{label}</span>
      {isPending ? (
        <div className="settings-confirm-actions">
          <button
            className="icon-button icon-button--small icon-button--success"
            disabled={disabled}
            onClick={onConfirm}
            title={t("common.confirm")}
            type="button"
          >
            <Check aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small icon-button--danger"
            onClick={onCancel}
            title={t("common.cancel")}
            type="button"
          >
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button
          className="icon-button icon-button--small"
          disabled={disabled}
          onClick={onConfirm}
          title={label}
          type="button"
        >
          <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-readout-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(log: { requestFinishedAt?: number; requestStartedAt: number }) {
  if (!log.requestFinishedAt) {
    return "-";
  }

  return `${Math.max(0, log.requestFinishedAt - log.requestStartedAt)} ms`;
}
