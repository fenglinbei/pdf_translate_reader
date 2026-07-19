import {
  Copy,
  Languages,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "../config/translationLanguages";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import type {
  AppSettings,
  PaperContext,
  PaperContextTerm,
  PdfLibraryEntry,
  TokenUsage,
  TranslationModel,
  TranslationRequest,
  TranslationStylePresetId,
  TranslationStyleSettings,
} from "../types/domain";
import { putApiCallLog } from "./apiLogRepository";
import { TRANSLATION_PROMPT_VERSION } from "./defaults";
import { getTranslationErrorMessage } from "./errors";
import { TRANSLATION_MODEL_OPTIONS } from "./models";
import { RichMathText } from "./RichMathText";
import { streamTranslation } from "./translationClient";
import {
  DEFAULT_TRANSLATION_STYLE,
  TRANSLATION_STYLE_CUSTOM_MAX_LENGTH,
  TRANSLATION_STYLE_PRESET_IDS,
  getEffectiveTranslationStyle,
  normalizeTranslationStyle,
} from "./translationStyle";

type FreeTranslationPanelProps = {
  entry: PdfLibraryEntry;
  onClose: () => void;
  paperContext?: PaperContext;
  settings: AppSettings;
};

type FreeTranslationStatus = "idle" | "loading" | "streaming" | "success" | "error";
type CopyStatus = "idle" | "copied" | "error";
type TermDraft = Pick<PaperContextTerm, "source" | "target"> & {
  id: string;
};

export function FreeTranslationPanel({
  entry,
  onClose,
  paperContext,
  settings,
}: FreeTranslationPanelProps) {
  const { t } = useI18n();
  const abortControllerRef = useRef<AbortController>();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [includePaperContext, setIncludePaperContext] = useState(true);
  const [inputText, setInputText] = useState("");
  const [model, setModel] = useState<TranslationModel>(settings.defaultModel);
  const [sourceLang, setSourceLang] = useState(settings.sourceLang);
  const [status, setStatus] = useState<FreeTranslationStatus>("idle");
  const [targetLang, setTargetLang] = useState(settings.targetLang);
  const [terms, setTerms] = useState<TermDraft[]>(() => createTermDrafts(paperContext?.terminology));
  const [translation, setTranslation] = useState("");
  const [translationStyle, setTranslationStyle] = useState<TranslationStyleSettings>(
    () => normalizeTranslationStyle(paperContext?.translationStyle ?? DEFAULT_TRANSLATION_STYLE),
  );
  const [usage, setUsage] = useState<TokenUsage>();
  const canTranslate = inputText.trim().length > 0 &&
    status !== "loading" &&
    status !== "streaming";

  useEffect(() => {
    setModel(settings.defaultModel);
    setSourceLang(settings.sourceLang);
    setTargetLang(settings.targetLang);
  }, [settings.defaultModel, settings.sourceLang, settings.targetLang]);

  useEffect(() => {
    setTerms(createTermDrafts(paperContext?.terminology));
    setTranslationStyle(normalizeTranslationStyle(paperContext?.translationStyle));
  }, [entry.fingerprint, paperContext?.contextHash, paperContext?.translationStyleHash]);

  useEffect(() => () => {
    abortControllerRef.current?.abort();
  }, []);

  const startTranslation = useCallback(() => {
    if (!inputText.trim()) {
      return;
    }

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const style = getEffectiveTranslationStyle(translationStyle);
    const now = Date.now();
    const request: TranslationRequest = {
      cloudDocumentId: entry.cloudDocumentId,
      contextWindowN: 0,
      localContextAfter: [],
      localContextBefore: [],
      longContextEnabled: includePaperContext,
      model,
      paperContext: includePaperContext ? paperContext : undefined,
      pdfFingerprint: entry.fingerprint,
      promptVersion: TRANSLATION_PROMPT_VERSION,
      requestKind: "free",
      sourceLang,
      stream: true,
      targetLang,
      targetSentence: inputText.trim(),
      terminologyOverride: termsToTerminology(terms),
      translationStyle: style.translationStyle,
      translationStyleHash: style.translationStyleHash,
    };

    setCopyStatus("idle");
    setErrorMessage(undefined);
    setStatus("loading");
    setTranslation("");
    setUsage(undefined);

    let streamedTranslation = "";
    let streamedUsage: TokenUsage | undefined;

    void (async () => {
      await streamTranslation(
        request,
        {
          onDelta: (text) => {
            streamedTranslation += text;
            setStatus("streaming");
            setTranslation((current) => current + text);
          },
          onUsage: (nextUsage) => {
            streamedUsage = nextUsage;
            setUsage(nextUsage);
          },
        },
        abortController.signal,
      );

      if (abortController.signal.aborted) {
        await putApiCallLog({
          request,
          requestFinishedAt: Date.now(),
          requestStartedAt: now,
          status: "aborted",
          usage: streamedUsage,
        }).catch(() => undefined);
        return;
      }

      if (!streamedTranslation.trim()) {
        throw new Error("Translation returned no text.");
      }

      await putApiCallLog({
        request,
        requestFinishedAt: Date.now(),
        requestStartedAt: now,
        status: "success",
        usage: streamedUsage,
      }).catch(() => undefined);
      setStatus("success");
    })().catch((error) => {
      const nextErrorMessage = getTranslationErrorMessage(error);

      if (abortController.signal.aborted) {
        void putApiCallLog({
          errorMessage: nextErrorMessage,
          request,
          requestFinishedAt: Date.now(),
          requestStartedAt: now,
          status: "aborted",
          usage: streamedUsage,
        }).catch(() => undefined);
        return;
      }

      setErrorMessage(nextErrorMessage);
      setStatus("error");
      void putApiCallLog({
        errorMessage: nextErrorMessage,
        request,
        requestFinishedAt: Date.now(),
        requestStartedAt: now,
        status: "error",
        usage: streamedUsage,
      }).catch(() => undefined);
    });
  }, [
    entry.cloudDocumentId,
    entry.fingerprint,
    includePaperContext,
    inputText,
    model,
    paperContext,
    sourceLang,
    targetLang,
    terms,
    translationStyle,
  ]);

  const handleCopy = useCallback(() => {
    if (!translation.trim()) {
      return;
    }

    void navigator.clipboard.writeText(translation)
      .then(() => setCopyStatus("copied"))
      .catch(() => setCopyStatus("error"));
  }, [translation]);

  function updateTerm(termId: string, patch: Partial<TermDraft>) {
    setTerms((currentTerms) =>
      currentTerms.map((term) => term.id === termId ? { ...term, ...patch } : term),
    );
  }

  return (
    <div
      className="free-translation-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      role="presentation"
    >
      <section className="free-translation-panel" aria-label={t("freeTranslation.title")}>
        <header className="free-translation-header">
          <div className="free-translation-heading">
            <Languages aria-hidden="true" size={18} strokeWidth={2} />
            <div>
              <div className="free-translation-title">{t("freeTranslation.title")}</div>
              <div className="free-translation-subtitle">{entry.pdfMetadata?.title || entry.fileName}</div>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} title={t("common.close")} type="button">
            <X aria-hidden="true" size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="free-translation-body">
          <div className="free-translation-main">
            <label className="settings-field">
              <span>{t("freeTranslation.sourceText")}</span>
              <textarea
                autoFocus
                onChange={(event) => {
                  setInputText(event.currentTarget.value);
                  setCopyStatus("idle");
                }}
                rows={8}
                value={inputText}
              />
            </label>
            <div className="free-translation-actions">
              <button
                className="primary-action-button"
                disabled={!canTranslate}
                onClick={startTranslation}
                type="button"
              >
                {status === "loading" || status === "streaming" ? (
                  <LoaderCircle aria-hidden="true" size={16} strokeWidth={2} />
                ) : (
                  <Languages aria-hidden="true" size={16} strokeWidth={2} />
                )}
                <span>{translation ? t("translation.retranslate") : t("pdf.translate")}</span>
              </button>
              <button
                className="icon-button"
                disabled={!canTranslate}
                onClick={startTranslation}
                title={t("translation.retranslate")}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              <button
                className="icon-button"
                disabled={!translation.trim()}
                onClick={handleCopy}
                title={t("common.copy")}
                type="button"
              >
                <Copy aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              {copyStatus !== "idle" ? (
                <span className={`free-translation-inline-status free-translation-inline-status--${copyStatus}`}>
                  {copyStatus === "copied" ? t("pdf.copied") : t("pdf.copyFailed")}
                </span>
              ) : null}
            </div>
            <div className={`free-translation-output free-translation-output--${status}`}>
              {errorMessage ? (
                errorMessage
              ) : translation ? (
                <RichMathText text={translation} />
              ) : status === "loading" || status === "streaming" ? (
                t("translation.translating")
              ) : (
                t("freeTranslation.emptyOutput")
              )}
            </div>
            {usage ? (
              <div className="translation-popover-meta">
                {t("translation.tokens")} {usage.totalTokens ?? "-"} · {t("translation.cacheHit")}{" "}
                {usage.promptCacheHitTokens ?? 0}
              </div>
            ) : null}
          </div>

          <aside className="free-translation-controls">
            <div className="settings-field-grid">
              <label className="settings-field">
                <span>{t("settings.source")}</span>
                <select
                  value={sourceLang}
                  onChange={(event) => {
                    const nextSourceLang = event.currentTarget.value as TranslationLanguage;
                    setSourceLang(nextSourceLang);
                    if (nextSourceLang === targetLang) {
                      setTargetLang(sourceLang);
                    }
                  }}
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
                  value={targetLang}
                  onChange={(event) => {
                    const nextTargetLang = event.currentTarget.value as TranslationLanguage;
                    setTargetLang(nextTargetLang);
                    if (nextTargetLang === sourceLang) {
                      setSourceLang(targetLang);
                    }
                  }}
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
                value={model}
                onChange={(event) => setModel(event.currentTarget.value as TranslationModel)}
              >
                {TRANSLATION_MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="settings-toggle">
              <input
                checked={includePaperContext}
                onChange={(event) => setIncludePaperContext(event.currentTarget.checked)}
                type="checkbox"
              />
              <span>{t("freeTranslation.includePaperContext")}</span>
            </label>
            <label className="settings-field">
              <span>{t("paperContext.translationStyle")}</span>
              <select
                value={translationStyle.presetId}
                onChange={(event) => {
                  const presetId = event.currentTarget.value as TranslationStylePresetId;
                  setTranslationStyle(presetId === "custom" ? { customInstruction: "", presetId } : { presetId });
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
              <label className="settings-field">
                <span>{t("paperContext.customTranslationStyle")}</span>
                <textarea
                  maxLength={TRANSLATION_STYLE_CUSTOM_MAX_LENGTH}
                  onChange={(event) => setTranslationStyle({
                    customInstruction: event.currentTarget.value,
                    presetId: "custom",
                  })}
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
                        onClick={() => setTerms((currentTerms) => currentTerms.filter((item) => item.id !== term.id))}
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
          </aside>
        </div>
      </section>
    </div>
  );
}

function createTermDrafts(terminology: PaperContextTerm[] | undefined): TermDraft[] {
  return (terminology ?? []).map((term, index) => ({
    id: `${term.source}-${term.updatedAt}-${index}`,
    source: term.source,
    target: term.target,
  }));
}

function termsToTerminology(terms: TermDraft[]): PaperContextTerm[] {
  const now = Date.now();

  return terms
    .map((term, index) => ({
      confidence: "user" as const,
      source: term.source.trim(),
      target: term.target.trim(),
      updatedAt: now + index,
    }))
    .filter((term) => term.source && term.target);
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
