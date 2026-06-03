import { useCallback, useEffect, useState } from "react";
import { Check, Trash2, X } from "lucide-react";
import {
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "../config/translationLanguages";
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
        setStatusMessage("Could not save settings.");
      }
    },
    [onSettingsChange],
  );

  const runConfirmedAction = useCallback(
    async (action: PendingAction, callback: () => Promise<void>, message: string) => {
      if (pendingAction !== action) {
        setPendingAction(action);
        setStatusMessage("Confirm the action to continue.");
        return;
      }

      try {
        setStatusMessage(undefined);
        await callback();
        setPendingAction(undefined);
        setStatusMessage(message);
        refreshUsageSummary();
      } catch {
        setStatusMessage("Action failed.");
      }
    },
    [pendingAction, refreshUsageSummary],
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
      <aside className="settings-panel" aria-label="Settings panel">
        <header className="settings-panel-header">
          <div>
            <div className="settings-panel-title">Settings</div>
            <div className="settings-panel-subtitle">Local reader preferences</div>
          </div>
          <button className="icon-button" onClick={onClose} title="Close settings" type="button">
            <X aria-hidden="true" size={18} strokeWidth={2} />
          </button>
        </header>

        {statusMessage ? <div className="settings-panel-status">{statusMessage}</div> : null}

        <section className="settings-section" aria-label="Translation settings">
          <div className="settings-section-heading">Translation</div>
          <div className="settings-field-grid">
            <label className="settings-field">
              <span>Source</span>
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
              <span>Target</span>
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
            <span>Default model</span>
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
            <span>Context window</span>
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
            <span>Long context</span>
          </label>
        </section>

        <section className="settings-section" aria-label="Selection settings">
          <div className="settings-section-heading">Selection</div>
          <label className="settings-field">
            <span>Dragged words</span>
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
              Maximum {MAX_DRAGGED_WORDS_LIMIT} words.
            </small>
          </label>
        </section>

        <section className="settings-section" aria-label="Paper context">
          <div className="settings-section-heading">Paper Context</div>
          <PaperContextEditor
            currentEntry={currentEntry}
            onSave={onPaperContextSave}
            paperContext={paperContext}
          />
        </section>

        <section className="settings-section" aria-label="API status and usage">
          <div className="settings-section-heading">API</div>
          <div className="settings-readout-list">
            <Readout label="Status" value={apiStatus} />
            <Readout
              label="API key"
              value={apiKeyConfigured === undefined ? "-" : apiKeyConfigured ? "configured" : "missing"}
            />
            <Readout
              label="Supabase"
              value={supabaseConfigured === undefined ? "-" : supabaseConfigured ? "configured" : "missing"}
            />
            <Readout label="Calls" value={String(usageSummary.totalCalls)} />
            <Readout label="Errors" value={String(usageSummary.errorCalls)} />
            <Readout label="Tokens" value={formatNumber(usageSummary.totalTokens)} />
            <Readout
              label="Models"
              value={`F ${usageSummary.modelCounts["deepseek-v4-flash"]} / P ${usageSummary.modelCounts["deepseek-v4-pro"]}`}
            />
            <Readout label="DS cache hit" value={formatNumber(usageSummary.cacheHitTokens)} />
            <Readout label="DS cache miss" value={formatNumber(usageSummary.cacheMissTokens)} />
          </div>
          <div className="settings-log-list" aria-label="Recent API calls">
            {usageSummary.recentLogs.length > 0
              ? usageSummary.recentLogs.map((log) => (
                  <div className="settings-log-row" key={log.id}>
                    <span>{log.model === "deepseek-v4-pro" ? "Pro" : "Flash"}</span>
                    <span>{log.status}</span>
                    <span>{formatDuration(log)}</span>
                    <span>{formatNumber(log.totalTokens ?? 0)}</span>
                  </div>
                ))
              : <div className="settings-empty-row">No API calls logged</div>}
          </div>
        </section>

        <section className="settings-section" aria-label="Library data management">
          <div className="settings-section-heading">Library Data</div>
          <div className="settings-action-list">
            <ConfirmButton
              disabled={false}
              isPending={pendingAction === "clear-cache"}
              label="Clear translation cache"
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-cache",
                  onClearTranslationCache,
                  "Translation cache cleared.",
                )
              }
            />
            <ConfirmButton
              disabled={!currentEntry}
              isPending={pendingAction === "clear-current-pdf"}
              label="Clear current PDF data"
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-current-pdf",
                  onClearCurrentPdfData,
                  "Current PDF data cleared.",
                )
              }
            />
            <ConfirmButton
              disabled={!currentEntry}
              isPending={pendingAction === "clear-current-pins"}
              label="Clear current PDF annotations"
              onCancel={() => setPendingAction(undefined)}
              onConfirm={() =>
                void runConfirmedAction(
                  "clear-current-pins",
                  onClearCurrentPdfPins,
                  "Current PDF annotations cleared.",
                )
              }
            />
          </div>
        </section>

        <section className="settings-section" aria-label="PDF history">
          <div className="settings-section-heading">PDF History</div>
          <div className="settings-history-list">
            {libraryEntries.length > 0
              ? libraryEntries.map((entry) => {
                  const actionId = `delete-pdf:${entry.cloudDocumentId}` as const;

                  return (
                    <div className="settings-history-row" key={entry.fingerprint}>
                      <div className="settings-history-main">
                        <div className="settings-history-title">{entry.pdfMetadata?.title || entry.fileName}</div>
                        <div className="settings-history-meta">
                          {formatBytes(entry.fileSize)} · {entry.openCount} opens
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
                                "PDF data removed.",
                              )
                            }
                            title="Confirm remove PDF data"
                            type="button"
                          >
                            <Check aria-hidden="true" size={16} strokeWidth={2} />
                          </button>
                          <button
                            className="icon-button icon-button--small icon-button--danger"
                            onClick={() => setPendingAction(undefined)}
                            title="Cancel"
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
                            setStatusMessage("Confirm the action to continue.");
                          }}
                          title="Remove PDF data"
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  );
                })
              : <div className="settings-empty-row">No PDFs in library</div>}
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
  return (
    <div className="settings-action-row">
      <span>{label}</span>
      {isPending ? (
        <div className="settings-confirm-actions">
          <button
            className="icon-button icon-button--small icon-button--success"
            disabled={disabled}
            onClick={onConfirm}
            title="Confirm"
            type="button"
          >
            <Check aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small icon-button--danger"
            onClick={onCancel}
            title="Cancel"
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

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDuration(log: { requestFinishedAt?: number; requestStartedAt: number }) {
  if (!log.requestFinishedAt) {
    return "-";
  }

  return `${Math.max(0, log.requestFinishedAt - log.requestStartedAt)} ms`;
}
