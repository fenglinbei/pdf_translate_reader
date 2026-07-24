import {
  ArrowLeftRight,
  ChevronRight,
  Copy,
  Languages,
  LoaderCircle,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TRANSLATION_LANGUAGES,
  type TranslationLanguage,
} from "../config/translationLanguages";
import { useI18n } from "../i18n/I18nProvider";
import type {
  AppSettings,
  FreeTranslationDraft,
  FreeTranslationRecord,
  FreeTranslationRequest,
  FreeTranslationRequestSnapshot,
  FreeTranslationSourceLanguage,
  FreeTranslationTerminologyEntry,
  PaperContext,
  PaperContextTerm,
  PdfLibraryEntry,
  TokenUsage,
  TranslationModel,
  TranslationReasoningEffort,
  TranslationStyleSettings,
} from "../types/domain";
import { copyTextToClipboard } from "../utils/clipboard";
import { putApiCallLog } from "./apiLogRepository";
import {
  FREE_TRANSLATION_MAX_SOURCE_CHARS,
  FREE_TRANSLATION_PROMPT_VERSION,
} from "./defaults";
import { getTranslationErrorMessage } from "./errors";
import { FreeTranslationHistory } from "./FreeTranslationHistory";
import { FreeTranslationMarkdown } from "./FreeTranslationMarkdown";
import {
  FreeTranslationOptions,
  type FreeTranslationTermDraft,
} from "./FreeTranslationOptions";
import {
  clearFreeTranslationHistory,
  deleteFreeTranslationRecord,
  getFreeTranslationDraft,
  listFreeTranslationHistory,
  putFreeTranslationDraft,
  putFreeTranslationRecord,
  type FreeTranslationDraftWriteInput,
} from "./freeTranslationRepository";
import { streamTranslation } from "./translationClient";
import { getTranslationReasoningCapability } from "./models";
import {
  DEFAULT_TRANSLATION_STYLE,
  getEffectiveTranslationStyle,
  normalizeTranslationStyle,
} from "./translationStyle";

type FreeTranslationPanelProps = {
  entry?: PdfLibraryEntry;
  initialText?: string;
  initialTextKey?: number;
  onClose: () => void;
  paperContext?: PaperContext;
  settings: AppSettings;
  userId: string;
};

type FreeTranslationStatus =
  | "idle"
  | "loading"
  | "streaming"
  | "success"
  | "stopped"
  | "error";
type CopyStatus = "idle" | "copied" | "error";
type DraftStatus = "idle" | "saving" | "saved" | "error";

const STANDALONE_PDF_FINGERPRINT = "standalone-free-translation";
const DRAFT_SAVE_DELAY_MS = 450;

export function FreeTranslationPanel({
  entry,
  initialText,
  initialTextKey,
  onClose,
  paperContext,
  settings,
  userId,
}: FreeTranslationPanelProps) {
  const { locale, t } = useI18n();
  const abortControllerRef = useRef<AbortController>();
  const activeRequestIdRef = useRef(0);
  const backdropRef = useRef<HTMLDivElement>(null);
  const draftSaveTimerRef = useRef<number>();
  const entryRef = useRef(entry);
  const hasUserInteractionRef = useRef(false);
  const initialTextRef = useRef(initialText);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isPanelMountedRef = useRef(false);
  const lastAppliedInitialTextKeyRef = useRef<number>();
  const lastSavedDraftSignatureRef = useRef<string>();
  const latestDraftRef = useRef<FreeTranslationDraftWriteInput>();
  const latestDraftSignatureRef = useRef<string>();
  const onCloseRef = useRef(onClose);
  const panelRef = useRef<HTMLElement>(null);
  const paperContextRef = useRef(paperContext);
  const [completedSignature, setCompletedSignature] = useState<string>();
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [historyError, setHistoryError] = useState<string>();
  const [historyRecords, setHistoryRecords] = useState<FreeTranslationRecord[]>([]);
  const [includePaperContext, setIncludePaperContext] = useState(Boolean(paperContext));
  const [inputText, setInputText] = useState("");
  const [isDraftHydrated, setIsDraftHydrated] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const [model, setModel] = useState<TranslationModel>(settings.defaultModel);
  const [reasoningEffort, setReasoningEffort] = useState<TranslationReasoningEffort>(
    () => getTranslationReasoningCapability(settings.defaultModel).defaultEffort,
  );
  const [reasoningEnabled, setReasoningEnabled] = useState(
    () => getTranslationReasoningCapability(settings.defaultModel).defaultEnabled,
  );
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  const [reasoningSummaryPending, setReasoningSummaryPending] = useState(false);
  const [reasoningSummary, setReasoningSummary] = useState("");
  const [sourceLang, setSourceLang] = useState<FreeTranslationSourceLanguage>("auto");
  const [status, setStatus] = useState<FreeTranslationStatus>("idle");
  const [targetLang, setTargetLang] = useState(settings.targetLang);
  const [terms, setTerms] = useState<FreeTranslationTermDraft[]>(() =>
    createTermDrafts(paperContext?.terminology)
  );
  const [translation, setTranslation] = useState("");
  const [translationStyle, setTranslationStyle] = useState<TranslationStyleSettings>(() =>
    normalizeTranslationStyle(paperContext?.translationStyle ?? DEFAULT_TRANSLATION_STYLE)
  );
  const [usage, setUsage] = useState<TokenUsage>();
  const isBusy = status === "loading" || status === "streaming";
  const paperTitle = entry?.pdfMetadata?.title || entry?.fileName;
  const effectiveIncludePaperContext = includePaperContext && Boolean(paperContext);
  const reasoningCapability = getTranslationReasoningCapability(model);
  const effectiveReasoningEnabled = reasoningCapability.canDisable
    ? reasoningEnabled
    : true;
  const effectiveReasoningEffort = reasoningCapability.efforts.includes(reasoningEffort)
    ? reasoningEffort
    : reasoningCapability.defaultEffort;
  const requestSnapshot = useMemo<FreeTranslationRequestSnapshot>(() => {
    const effectiveStyle = getEffectiveTranslationStyle(translationStyle);

    return {
      includePaperContext: effectiveIncludePaperContext,
      model,
      paperContextHash: effectiveIncludePaperContext ? paperContext?.contextHash : undefined,
      promptVersion: FREE_TRANSLATION_PROMPT_VERSION,
      reasoningEffort: effectiveReasoningEffort,
      reasoningEnabled: effectiveReasoningEnabled,
      sourceLang,
      targetLang,
      terminology: termsToEntries(terms),
      translationStyle: effectiveStyle.translationStyle,
      translationStyleHash: effectiveStyle.translationStyleHash,
    };
  }, [
    effectiveIncludePaperContext,
    model,
    paperContext?.contextHash,
    effectiveReasoningEffort,
    effectiveReasoningEnabled,
    sourceLang,
    targetLang,
    terms,
    translationStyle,
  ]);
  const draftInput = useMemo<FreeTranslationDraftWriteInput>(() => ({
    includePaperContext: effectiveIncludePaperContext,
    model,
    pdfFingerprint: entry?.fingerprint,
    pdfTitle: paperTitle,
    reasoningEffort: effectiveReasoningEffort,
    reasoningEnabled: effectiveReasoningEnabled,
    sourceLang,
    sourceText: inputText,
    targetLang,
    terminology: termsToEntries(terms),
    translationStyle,
    userId,
  }), [
    effectiveIncludePaperContext,
    entry?.fingerprint,
    inputText,
    model,
    paperTitle,
    effectiveReasoningEffort,
    effectiveReasoningEnabled,
    sourceLang,
    targetLang,
    terms,
    translationStyle,
    userId,
  ]);
  const draftSignature = useMemo(() => JSON.stringify(draftInput), [draftInput]);
  const currentSignature = useMemo(
    () => createResultSignature(inputText, requestSnapshot),
    [inputText, requestSnapshot],
  );
  const isResultStale = Boolean(
    translation && completedSignature && completedSignature !== currentSignature,
  );
  const canTranslate = Boolean(inputText.trim()) &&
    inputText.length <= FREE_TRANSLATION_MAX_SOURCE_CHARS &&
    !isBusy;
  const canCopy = Boolean(translation.trim()) && status === "success" && !isResultStale;

  entryRef.current = entry;
  paperContextRef.current = paperContext;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    initialTextRef.current = initialText;
  }, [initialText]);

  useEffect(() => {
    isPanelMountedRef.current = true;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab" || !panelRef.current) {
        return;
      }

      const focusableElements = getFocusableElements(panelRef.current);

      if (focusableElements.length === 0) {
        event.preventDefault();
        panelRef.current.focus({ preventScroll: true });
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements.at(-1)!;
      const activeElement = document.activeElement;

      if (event.shiftKey && (activeElement === firstElement || !panelRef.current.contains(activeElement))) {
        event.preventDefault();
        lastElement.focus({ preventScroll: true });
      } else if (!event.shiftKey && (activeElement === lastElement || !panelRef.current.contains(activeElement))) {
        event.preventDefault();
        firstElement.focus({ preventScroll: true });
      }
    };

    const backdrop = backdropRef.current;
    const backgroundElements = backdrop?.parentElement
      ? Array.from(backdrop.parentElement.children)
        .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop)
        .map((element) => ({
          ariaHidden: element.getAttribute("aria-hidden"),
          element,
          inert: element.inert,
        }))
      : [];
    const previousBodyOverflow = document.body.style.overflow;

    backgroundElements.forEach(({ element }) => {
      element.inert = true;
      element.setAttribute("aria-hidden", "true");
    });
    document.body.style.overflow = "hidden";

    window.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);

    return () => {
      isPanelMountedRef.current = false;
      window.removeEventListener("keydown", handleKeyDown);
      abortControllerRef.current?.abort();
      window.clearTimeout(draftSaveTimerRef.current);
      const latestDraft = latestDraftRef.current;
      const latestDraftSignature = latestDraftSignatureRef.current;

      if (
        latestDraft &&
        latestDraftSignature &&
        latestDraftSignature !== lastSavedDraftSignatureRef.current
      ) {
        void putFreeTranslationDraft(latestDraft).catch(() => undefined);
      }
      backgroundElements.forEach(({ ariaHidden, element, inert }) => {
        element.inert = inert;
        if (ariaHidden === null) {
          element.removeAttribute("aria-hidden");
        } else {
          element.setAttribute("aria-hidden", ariaHidden);
        }
      });
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, []);

  const resetResult = useCallback(() => {
    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    abortControllerRef.current = undefined;
    setCompletedSignature(undefined);
    setCopyStatus("idle");
    setErrorMessage(undefined);
    setReasoningExpanded(false);
    setReasoningSummaryPending(false);
    setReasoningSummary("");
    setStatus("idle");
    setTranslation("");
    setUsage(undefined);
  }, []);

  const refreshHistory = useCallback(async () => {
    setIsHistoryLoading(true);
    setHistoryError(undefined);

    try {
      setHistoryRecords(await listFreeTranslationHistory(userId));
    } catch {
      setHistoryError(t("freeTranslation.historyError"));
    } finally {
      setIsHistoryLoading(false);
    }
  }, [t, userId]);

  useEffect(() => {
    let cancelled = false;

    void getFreeTranslationDraft(userId)
      .then((draft) => {
        if (
          !cancelled &&
          draft &&
          !hasUserInteractionRef.current &&
          !initialTextRef.current?.trim()
        ) {
          applyDraft(draft, {
            entry: entryRef.current,
            paperContext: paperContextRef.current,
            setIncludePaperContext,
            setInputText,
            setModel,
            setReasoningEffort,
            setReasoningEnabled,
            setSourceLang,
            setTargetLang,
            setTerms,
            setTranslationStyle,
          });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setIsDraftHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    const nextInitialText = initialTextRef.current;

    if (
      initialTextKey === undefined ||
      lastAppliedInitialTextKeyRef.current === initialTextKey ||
      !nextInitialText?.trim()
    ) {
      return;
    }

    const activePaperContext = paperContextRef.current;

    lastAppliedInitialTextKeyRef.current = initialTextKey;
    hasUserInteractionRef.current = true;
    resetResult();
    setInputText(nextInitialText.slice(0, FREE_TRANSLATION_MAX_SOURCE_CHARS));
    setIncludePaperContext(Boolean(activePaperContext));
    setTerms(createTermDrafts(activePaperContext?.terminology));
    setTranslationStyle(normalizeTranslationStyle(
      activePaperContext?.translationStyle ?? DEFAULT_TRANSLATION_STYLE,
    ));
  }, [initialTextKey, resetResult]);

  useEffect(() => {
    if (!isDraftHydrated && !hasUserInteractionRef.current) {
      return;
    }

    latestDraftRef.current = draftInput;
    latestDraftSignatureRef.current = draftSignature;
  }, [draftInput, draftSignature, isDraftHydrated]);

  useEffect(() => {
    if (!isDraftHydrated) {
      return undefined;
    }

    window.clearTimeout(draftSaveTimerRef.current);
    if (lastSavedDraftSignatureRef.current === draftSignature) {
      setDraftStatus("saved");
      return undefined;
    }

    setDraftStatus("saving");
    draftSaveTimerRef.current = window.setTimeout(() => {
      draftSaveTimerRef.current = undefined;
      void putFreeTranslationDraft(draftInput)
        .then(() => {
          lastSavedDraftSignatureRef.current = draftSignature;
          if (
            isPanelMountedRef.current &&
            latestDraftSignatureRef.current === draftSignature
          ) {
            setDraftStatus("saved");
          }
        })
        .catch(() => {
          if (
            isPanelMountedRef.current &&
            latestDraftSignatureRef.current === draftSignature
          ) {
            setDraftStatus("error");
          }
        });
    }, DRAFT_SAVE_DELAY_MS);

    return () => window.clearTimeout(draftSaveTimerRef.current);
  }, [
    draftInput,
    draftSignature,
    isDraftHydrated,
  ]);

  const startTranslation = useCallback(() => {
    if (!canTranslate) {
      return;
    }

    abortControllerRef.current?.abort();
    const abortController = new AbortController();
    const requestId = activeRequestIdRef.current + 1;
    const now = Date.now();
    let activeSnapshot = requestSnapshot;
    const request: FreeTranslationRequest = {
      cloudDocumentId: entry?.cloudDocumentId,
      contextWindowN: 0,
      localContextAfter: [],
      localContextBefore: [],
      longContextEnabled: effectiveIncludePaperContext,
      model,
      paperContext: effectiveIncludePaperContext ? paperContext : undefined,
      pdfFingerprint: entry?.fingerprint ?? STANDALONE_PDF_FINGERPRINT,
      promptVersion: FREE_TRANSLATION_PROMPT_VERSION,
      reasoningEffort: effectiveReasoningEffort,
      reasoningEnabled: effectiveReasoningEnabled,
      requestKind: "free",
      sourceLang,
      stream: true,
      summaryLocale: locale,
      targetLang,
      targetSentence: inputText,
      terminologyOverride: entriesToPaperContextTerms(requestSnapshot.terminology),
      translationStyle: requestSnapshot.translationStyle,
      translationStyleHash: requestSnapshot.translationStyleHash,
    };

    abortControllerRef.current = abortController;
    activeRequestIdRef.current = requestId;
    setCompletedSignature(undefined);
    setCopyStatus("idle");
    setErrorMessage(undefined);
    setReasoningExpanded(false);
    setReasoningSummaryPending(false);
    setReasoningSummary("");
    setStatus("loading");
    setTranslation("");
    setUsage(undefined);

    let streamedTranslation = "";
    let streamedReasoningSummary = "";
    let streamedUsage: TokenUsage | undefined;

    void (async () => {
      try {
        await streamTranslation(
          request,
          {
            onDelta: (text) => {
              if (activeRequestIdRef.current !== requestId) {
                return;
              }

              streamedTranslation += text;
              setStatus("streaming");
              setTranslation((current) => current + text);
            },
            onMeta: (metadata) => {
              if (metadata.promptVersion) {
                request.promptVersion = metadata.promptVersion;
                activeSnapshot = {
                  ...activeSnapshot,
                  promptVersion: metadata.promptVersion,
                };
              }

              if (metadata.reasoning) {
                request.reasoningEnabled = metadata.reasoning.enabled;
                request.reasoningEffort = metadata.reasoning.effort;
                activeSnapshot = {
                  ...activeSnapshot,
                  reasoningEnabled: metadata.reasoning.enabled,
                  reasoningEffort: metadata.reasoning.effort,
                };
              }
            },
            onReasoningSummary: (text) => {
              if (activeRequestIdRef.current !== requestId) {
                return;
              }

              streamedReasoningSummary = text;
              setReasoningSummaryPending(false);
              setReasoningSummary(text);
            },
            onReasoningSummaryStatus: () => {
              if (activeRequestIdRef.current !== requestId) {
                return;
              }

              setReasoningSummaryPending(true);
            },
            onUsage: (nextUsage) => {
              if (activeRequestIdRef.current !== requestId) {
                return;
              }

              streamedUsage = nextUsage;
              setUsage(nextUsage);
            },
          },
          abortController.signal,
        );

        if (abortController.signal.aborted || activeRequestIdRef.current !== requestId) {
          return;
        }

        if (!streamedTranslation.trim()) {
          throw new Error("Translation returned no text.");
        }

        if (activeRequestIdRef.current === requestId) {
          setReasoningSummaryPending(false);
          setCompletedSignature(createResultSignature(inputText, activeSnapshot));
          setStatus("success");
        }

        void putApiCallLog({
          request,
          requestFinishedAt: Date.now(),
          requestStartedAt: now,
          status: "success",
          usage: streamedUsage,
        }).catch(() => undefined);

        try {
          const record = await putFreeTranslationRecord({
            cloudDocumentId: entry?.cloudDocumentId,
            pdfFingerprint: entry?.fingerprint,
            pdfTitle: paperTitle,
            request: activeSnapshot,
            reasoningSummary: streamedReasoningSummary,
            sourceText: inputText,
            translation: streamedTranslation,
            usage: streamedUsage,
            userId,
          });

          if (activeRequestIdRef.current === requestId) {
            setHistoryRecords((current) => [
              record,
              ...current.filter((item) => item.id !== record.id),
            ].slice(0, 20));
          }
        } catch {
          if (activeRequestIdRef.current === requestId) {
            setHistoryError(t("freeTranslation.historyError"));
          }
        }
      } catch (error) {
        const nextErrorMessage = getTranslationErrorMessage(error);

        if (abortController.signal.aborted) {
          await putApiCallLog({
            errorMessage: nextErrorMessage,
            request,
            requestFinishedAt: Date.now(),
            requestStartedAt: now,
            status: "aborted",
            usage: streamedUsage,
          }).catch(() => undefined);
          return;
        }

        if (activeRequestIdRef.current === requestId) {
          setReasoningSummaryPending(false);
          setErrorMessage(nextErrorMessage);
          setStatus("error");
        }
        await putApiCallLog({
          errorMessage: nextErrorMessage,
          request,
          requestFinishedAt: Date.now(),
          requestStartedAt: now,
          status: "error",
          usage: streamedUsage,
        }).catch(() => undefined);
      }
    })();
  }, [
    canTranslate,
    effectiveIncludePaperContext,
    effectiveReasoningEffort,
    effectiveReasoningEnabled,
    entry?.cloudDocumentId,
    entry?.fingerprint,
    inputText,
    locale,
    model,
    paperContext,
    paperTitle,
    requestSnapshot,
    sourceLang,
    targetLang,
    t,
    userId,
  ]);

  const handleStop = useCallback(() => {
    if (!isBusy) {
      return;
    }

    activeRequestIdRef.current += 1;
    abortControllerRef.current?.abort();
    setCompletedSignature(undefined);
    setErrorMessage(t("freeTranslation.stopped"));
    setReasoningSummaryPending(false);
    setStatus("stopped");
  }, [isBusy, t]);

  const handleCopy = useCallback(async () => {
    if (!canCopy) {
      return;
    }

    try {
      await copyTextToClipboard(translation);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }, [canCopy, translation]);

  const handleSourceKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startTranslation();
    }
  }, [startTranslation]);

  const handleSwapLanguages = useCallback(() => {
    if (sourceLang === "auto" || isBusy) {
      return;
    }

    hasUserInteractionRef.current = true;
    setSourceLang(targetLang);
    setTargetLang(sourceLang);
    setCopyStatus("idle");
  }, [isBusy, sourceLang, targetLang]);

  const handleRestoreHistory = useCallback((record: FreeTranslationRecord) => {
    hasUserInteractionRef.current = true;
    abortControllerRef.current?.abort();
    activeRequestIdRef.current += 1;
    const canRestorePaperContext = Boolean(
      record.request.includePaperContext &&
      paperContext &&
      (!record.pdfFingerprint || record.pdfFingerprint === entry?.fingerprint),
    );
    const restoredSnapshot: FreeTranslationRequestSnapshot = {
      ...record.request,
      includePaperContext: canRestorePaperContext,
      paperContextHash: canRestorePaperContext ? paperContext?.contextHash : undefined,
    };

    setSourceLang(record.request.sourceLang);
    setTargetLang(record.request.targetLang);
    setModel(record.request.model);
    setIncludePaperContext(canRestorePaperContext);
    setInputText(record.sourceText);
    setTerms(createTermDrafts(record.request.terminology));
    setReasoningEnabled(record.request.reasoningEnabled);
    setReasoningEffort(record.request.reasoningEffort);
    setReasoningExpanded(false);
    setReasoningSummaryPending(false);
    setReasoningSummary(record.reasoningSummary ?? "");
    setTranslationStyle(normalizeTranslationStyle(record.request.translationStyle));
    setTranslation(record.translation);
    setUsage(record.usage);
    setCopyStatus("idle");
    setErrorMessage(undefined);
    setCompletedSignature(createResultSignature(record.sourceText, restoredSnapshot));
    setStatus("success");
  }, [entry?.fingerprint, paperContext]);

  const handleDeleteHistory = useCallback((record: FreeTranslationRecord) => {
    void deleteFreeTranslationRecord(userId, record.id)
      .then(() => {
        setHistoryRecords((current) => current.filter((item) => item.id !== record.id));
      })
      .catch(() => setHistoryError(t("freeTranslation.historyError")));
  }, [t, userId]);

  const handleClearHistory = useCallback(() => {
    if (!window.confirm(t("freeTranslation.clearHistoryConfirm"))) {
      return;
    }

    void clearFreeTranslationHistory(userId)
      .then(() => setHistoryRecords([]))
      .catch(() => setHistoryError(t("freeTranslation.historyError")));
  }, [t, userId]);

  function handleSourceLanguageChange(nextSourceLang: FreeTranslationSourceLanguage) {
    hasUserInteractionRef.current = true;
    setSourceLang(nextSourceLang);
    setCopyStatus("idle");

    if (nextSourceLang !== "auto" && nextSourceLang === targetLang) {
      setTargetLang(findAlternativeLanguage(nextSourceLang));
    }
  }

  function handleTargetLanguageChange(nextTargetLang: TranslationLanguage) {
    hasUserInteractionRef.current = true;
    setTargetLang(nextTargetLang);
    setCopyStatus("idle");

    if (sourceLang === nextTargetLang) {
      setSourceLang("auto");
    }
  }

  return (
    <div
      className="free-translation-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      ref={backdropRef}
      role="presentation"
    >
      <section
        aria-label={t("freeTranslation.title")}
        aria-modal="true"
        className="free-translation-panel"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="free-translation-header">
          <div className="free-translation-heading">
            <Languages aria-hidden="true" size={19} strokeWidth={2} />
            <div>
              <div className="free-translation-title">{t("freeTranslation.title")}</div>
              <div className="free-translation-subtitle">
                {paperTitle || t("freeTranslation.standalone")}
              </div>
            </div>
          </div>
          <div className="free-translation-header-actions">
            {paperContext && paperTitle ? (
              <span className="free-translation-context-chip">
                {t("freeTranslation.contextActive", { title: paperTitle })}
              </span>
            ) : null}
            <button
              aria-label={t("common.close")}
              className="icon-button"
              onClick={onClose}
              title={t("common.close")}
              type="button"
            >
              <X aria-hidden="true" size={18} strokeWidth={2} />
            </button>
          </div>
        </header>

        <div className="free-translation-body">
          <div className="free-translation-workbench">
            <section className="free-translation-pane free-translation-pane--source">
              <header className="free-translation-pane-header">
                <label className="free-translation-language-select">
                  <span className="sr-only">{t("settings.source")}</span>
                  <select
                    aria-label={t("settings.source")}
                    disabled={isBusy}
                    onChange={(event) => handleSourceLanguageChange(
                      event.currentTarget.value as FreeTranslationSourceLanguage,
                    )}
                    value={sourceLang}
                  >
                    <option value="auto">{t("freeTranslation.autoDetect")}</option>
                    {TRANSLATION_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>{language.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  aria-label={t("freeTranslation.clearSource")}
                  className="icon-button icon-button--small"
                  disabled={!inputText || isBusy}
                  onClick={() => {
                    hasUserInteractionRef.current = true;
                    setInputText("");
                    resetResult();
                  }}
                  title={t("freeTranslation.clearSource")}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </header>
              <textarea
                aria-label={t("freeTranslation.sourceText")}
                className="free-translation-source-input"
                maxLength={FREE_TRANSLATION_MAX_SOURCE_CHARS}
                onChange={(event) => {
                  hasUserInteractionRef.current = true;
                  setInputText(event.currentTarget.value);
                  setCopyStatus("idle");
                }}
                onKeyDown={handleSourceKeyDown}
                placeholder={t("freeTranslation.sourcePlaceholder")}
                ref={inputRef}
                value={inputText}
              />
              <footer className="free-translation-pane-footer">
                <div className="free-translation-source-meta">
                  <span>{t("freeTranslation.characterCount", {
                    count: inputText.length,
                    limit: FREE_TRANSLATION_MAX_SOURCE_CHARS,
                  })}</span>
                  <span>{t("freeTranslation.inputHint")}</span>
                </div>
                <button
                  className="primary-action-button"
                  disabled={!canTranslate}
                  onClick={startTranslation}
                  type="button"
                >
                  <Languages aria-hidden="true" size={16} strokeWidth={2} />
                  <span>{translation ? t("translation.retranslate") : t("pdf.translate")}</span>
                </button>
              </footer>
            </section>

            <button
              aria-label={t("freeTranslation.swapLanguages")}
              className="free-translation-swap-button"
              disabled={sourceLang === "auto" || isBusy}
              onClick={handleSwapLanguages}
              title={t("freeTranslation.swapLanguages")}
              type="button"
            >
              <ArrowLeftRight aria-hidden="true" size={17} strokeWidth={2} />
            </button>

            <section className="free-translation-pane free-translation-pane--result">
              <header className="free-translation-pane-header">
                <label className="free-translation-language-select">
                  <span className="sr-only">{t("settings.target")}</span>
                  <select
                    aria-label={t("settings.target")}
                    disabled={isBusy}
                    onChange={(event) => handleTargetLanguageChange(
                      event.currentTarget.value as TranslationLanguage,
                    )}
                    value={targetLang}
                  >
                    {TRANSLATION_LANGUAGES.map((language) => (
                      <option key={language.code} value={language.code}>{language.label}</option>
                    ))}
                  </select>
                </label>
                <div className="free-translation-result-actions">
                  {isBusy ? (
                    <button
                      aria-label={t("freeTranslation.stop")}
                      className="icon-button icon-button--small"
                      onClick={handleStop}
                      title={t("freeTranslation.stop")}
                      type="button"
                    >
                      <Square aria-hidden="true" size={14} strokeWidth={2.2} />
                    </button>
                  ) : null}
                  <button
                    aria-label={t("common.copy")}
                    className="icon-button icon-button--small"
                    disabled={!canCopy}
                    onClick={() => void handleCopy()}
                    title={t("common.copy")}
                    type="button"
                  >
                    <Copy aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                </div>
              </header>
              <div
                aria-busy={isBusy}
                aria-live={isBusy ? "off" : "polite"}
                className={`free-translation-output free-translation-output--${status}`}
              >
                {reasoningSummaryPending || reasoningSummary ? (
                  <FreeTranslationReasoningPanel
                    expanded={reasoningExpanded}
                    isGenerating={reasoningSummaryPending}
                    onExpandedChange={setReasoningExpanded}
                    text={reasoningSummary}
                  />
                ) : null}
                {translation ? (
                  <FreeTranslationMarkdown text={translation} />
                ) : status === "loading" || status === "streaming" ? (
                  <div className="free-translation-loading">
                    <LoaderCircle aria-hidden="true" size={17} strokeWidth={2} />
                    <span>{t("translation.translating")}</span>
                  </div>
                ) : (
                  t("freeTranslation.emptyOutput")
                )}
              </div>
              <footer className="free-translation-pane-footer free-translation-result-footer">
                <div className="free-translation-result-status" role="status">
                  {isResultStale ? (
                    <span className="free-translation-stale-notice">
                      {t("freeTranslation.staleResult")}
                    </span>
                  ) : errorMessage ? (
                    <span className={status === "error" ? "free-translation-error-notice" : ""}>
                      {errorMessage}
                    </span>
                  ) : copyStatus !== "idle" ? (
                    <span className={`free-translation-inline-status free-translation-inline-status--${copyStatus}`}>
                      {copyStatus === "copied" ? t("pdf.copied") : t("pdf.copyFailed")}
                    </span>
                  ) : usage ? (
                    <span>
                      {t("translation.tokens")} {usage.totalTokens ?? "-"} ·{" "}
                      {t("translation.cacheHit")} {usage.promptCacheHitTokens ?? 0}
                    </span>
                  ) : null}
                </div>
                <span className="free-translation-draft-status">
                  {draftStatus === "saving"
                    ? t("freeTranslation.draftSaving")
                    : draftStatus === "saved"
                      ? t("freeTranslation.draftSaved")
                      : draftStatus === "error"
                        ? t("freeTranslation.draftError")
                        : t("freeTranslation.localDraft")}
                </span>
              </footer>
            </section>
          </div>

          <div className="free-translation-lower-panels">
            <FreeTranslationOptions
              disabled={isBusy}
              hasPaperContext={Boolean(paperContext)}
              includePaperContext={includePaperContext}
              model={model}
              onIncludePaperContextChange={(enabled) => {
                hasUserInteractionRef.current = true;
                setIncludePaperContext(enabled);
              }}
              onModelChange={(nextModel) => {
                hasUserInteractionRef.current = true;
                const currentCapability = getTranslationReasoningCapability(model);
                const nextCapability = getTranslationReasoningCapability(nextModel);

                setModel(nextModel);
                setReasoningEnabled((current) => {
                  if (!nextCapability.canDisable) {
                    return true;
                  }

                  return currentCapability.canDisable
                    ? current
                    : nextCapability.defaultEnabled;
                });
                setReasoningEffort((current) =>
                  nextCapability.efforts.includes(current)
                    ? current
                    : nextCapability.defaultEffort
                );
              }}
              onReasoningEffortChange={(effort) => {
                hasUserInteractionRef.current = true;
                setReasoningEffort(effort);
              }}
              onReasoningEnabledChange={(enabled) => {
                hasUserInteractionRef.current = true;
                setReasoningEnabled(enabled);
              }}
              onTranslationStyleChange={(nextStyle) => {
                hasUserInteractionRef.current = true;
                setTranslationStyle(nextStyle);
              }}
              setTerms={(action) => {
                hasUserInteractionRef.current = true;
                setTerms(action);
              }}
              terms={terms}
              reasoningEffort={effectiveReasoningEffort}
              reasoningEnabled={effectiveReasoningEnabled}
              translationStyle={translationStyle}
            />
            <FreeTranslationHistory
              error={historyError}
              isLoading={isHistoryLoading}
              onClear={handleClearHistory}
              onDelete={handleDeleteHistory}
              onRestore={handleRestoreHistory}
              records={historyRecords}
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function FreeTranslationReasoningPanel({
  expanded,
  isGenerating,
  onExpandedChange,
  text,
}: {
  expanded: boolean;
  isGenerating: boolean;
  onExpandedChange: (expanded: boolean) => void;
  text: string;
}) {
  const { t } = useI18n();

  return (
    <div className="free-translation-reasoning-panel">
      <button
        aria-controls="free-translation-reasoning-summary"
        aria-expanded={expanded}
        className="free-translation-reasoning-toggle"
        disabled={!text}
        onClick={() => onExpandedChange(!expanded)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className="free-translation-reasoning-toggle-icon"
          size={14}
          strokeWidth={2.2}
        />
        <span>{t("freeTranslation.reasoningPanel")}</span>
        {isGenerating ? <small>{t("freeTranslation.reasoningThinking")}</small> : null}
      </button>
      <div
        className="free-translation-reasoning-text"
        hidden={!expanded}
        id="free-translation-reasoning-summary"
      >
        {text}
      </div>
    </div>
  );
}

function applyDraft(
  draft: FreeTranslationDraft,
  setters: {
    entry?: PdfLibraryEntry;
    paperContext?: PaperContext;
    setIncludePaperContext: (value: boolean) => void;
    setInputText: (value: string) => void;
    setModel: (value: TranslationModel) => void;
    setReasoningEffort: (value: TranslationReasoningEffort) => void;
    setReasoningEnabled: (value: boolean) => void;
    setSourceLang: (value: FreeTranslationSourceLanguage) => void;
    setTargetLang: (value: TranslationLanguage) => void;
    setTerms: (value: FreeTranslationTermDraft[]) => void;
    setTranslationStyle: (value: TranslationStyleSettings) => void;
  },
) {
  const contextMatches = Boolean(
    setters.paperContext &&
    (!draft.pdfFingerprint || draft.pdfFingerprint === setters.entry?.fingerprint),
  );

  setters.setInputText(draft.sourceText.slice(0, FREE_TRANSLATION_MAX_SOURCE_CHARS));
  setters.setSourceLang(draft.sourceLang);
  setters.setTargetLang(draft.targetLang);
  setters.setModel(draft.model);
  setters.setReasoningEffort(draft.reasoningEffort);
  setters.setReasoningEnabled(draft.reasoningEnabled);
  setters.setIncludePaperContext(draft.includePaperContext && contextMatches);
  setters.setTranslationStyle(normalizeTranslationStyle(draft.translationStyle));
  setters.setTerms(createTermDrafts(draft.terminology));
}

function createTermDrafts(
  terminology: Array<Pick<PaperContextTerm, "source" | "target">> | undefined,
): FreeTranslationTermDraft[] {
  return (terminology ?? []).map((term, index) => ({
    id: `free-term-${index}-${term.source}-${term.target}`,
    source: term.source,
    target: term.target,
  }));
}

function termsToEntries(terms: FreeTranslationTermDraft[]): FreeTranslationTerminologyEntry[] {
  return terms
    .map((term) => ({
      source: term.source.trim(),
      target: term.target.trim(),
    }))
    .filter((term) => term.source || term.target);
}

function entriesToPaperContextTerms(entries: FreeTranslationTerminologyEntry[]): PaperContextTerm[] {
  const now = Date.now();

  return entries
    .filter((term) => term.source && term.target)
    .map((term, index) => ({
      confidence: "user" as const,
      source: term.source,
      target: term.target,
      updatedAt: now + index,
    }));
}

function createResultSignature(
  sourceText: string,
  request: FreeTranslationRequestSnapshot,
) {
  return JSON.stringify({ request, sourceText });
}

function getFocusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>([
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "summary",
    "textarea:not([disabled])",
    '[tabindex]:not([tabindex="-1"])',
  ].join(","))).filter((element) =>
    !element.matches(":disabled") &&
    element.getAttribute("aria-hidden") !== "true" &&
    element.getClientRects().length > 0
  );
}

function findAlternativeLanguage(language: TranslationLanguage) {
  return TRANSLATION_LANGUAGES.find((item) => item.code !== language)?.code ?? "zh";
}
