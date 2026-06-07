import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Activity,
  Archive,
  Check,
  CircleAlert,
  Combine,
  Download,
  Hand,
  LoaderCircle,
  LogOut,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
  X,
} from "lucide-react";
import {
  deletePdfLocalData,
  saveImportedPdf,
  updatePdfReadingPosition,
  type ReadingPositionUpdate,
} from "../cache/pdfLibraryRepository";
import { useAuth } from "../auth/AuthProvider";
import {
  deleteCloudPdfDocument,
  importPdfToCloud,
  listCloudPdfLibraryEntries,
  openCloudPdfDocument,
  updateCloudReadingPosition,
} from "../cloud/pdfCloudRepository";
import { hydrateCloudDocumentState } from "../cloud/documentStateRepository";
import {
  CLOUD_SYNC_ERROR_EVENT,
  CLOUD_SYNC_STATUS_EVENT,
  type CloudSyncStatus,
  getCloudSyncErrorMessage,
  getCloudSyncStatusDetail,
} from "../cloud/syncStatus";
import { PROJECT_CONFIG } from "../config/projectConfig";
import { createI18n, I18nProvider } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import {
  createDocumentArchive,
  importDocumentArchiveState,
  isDocumentArchiveFile,
  parseDocumentArchive,
} from "../importExport/documentArchive";
import { downloadBlob, replaceFileExtension } from "../importExport/download";
import type { DocumentArchiveDocument } from "../importExport/archiveTypes";
import { PdfImportDropzone } from "../pdf/PdfImportDropzone";
import { PdfLibrary } from "../pdf/PdfLibrary";
import { createPdfFingerprint } from "../pdf/pdfFingerprint";
import { PdfViewer, type PinLocateRequest } from "../pdf/PdfViewer";
import {
  deletePin,
  deletePinsByPdf,
  listPinsByPdf,
  putPin,
  updatePinAnnotation,
  updatePinHighlight,
  updatePinTranslation,
  type PinAnnotationInput,
  type PinWriteInput,
} from "../pins/pinRepository";
import {
  PinnedTranslationsPanel,
  type PinPanelFocusRequest,
} from "../pins/PinnedTranslationsPanel";
import { SettingsButton } from "../settings/SettingsButton";
import { SettingsPanel } from "../settings/SettingsPanel";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  putAppSettings,
} from "../settings/settingsRepository";
import type {
  AppSettings,
  CloudPdfLibraryEntry,
  MobileInteractionMode,
  MathpixDocumentRecord,
  MathpixParsedPage,
  PaperContextRecord,
  PdfLibraryEntry,
  SelectionMode,
  SentenceSelection,
  TranslationPin,
} from "../types/domain";
import type {
  PinnedTranslationCard,
  TranslationCardPinInput,
  TranslationFavoriteAction,
  TranslationCardViewChange,
  TranslationCardViewChangeOptions,
} from "../translation/floatingCardTypes";
import {
  ensurePaperContextForEntry,
  saveUserPaperContext,
  updatePaperContextFromPageTexts,
  type PaperContextDraft,
} from "../translation/paperContext";
import {
  deletePinnedTranslationCard,
  listPinnedTranslationCardsByPdf,
  putPinnedTranslationCard,
} from "../translation/pinnedTranslationCardRepository";
import { clearTranslationCache } from "../translation/translationRepository";
import { getStorageErrorMessage } from "../translation/errors";
import { TRANSLATION_PROMPT_VERSION } from "../translation/defaults";
import { runMathpixParsePipeline } from "../mathpix/mathpixPipeline";
import { getMathpixDocumentRecord, mapPagesByIndex } from "../mathpix/mathpixRepository";
import { MATHPIX_OPTIONS_HASH } from "../mathpix/options";
import { resolveMathpixSelectionText } from "../mathpix/mathpixSelectionResolver";
import {
  clearReaderSessionDocument,
  getReaderSession,
  updateReaderSession,
} from "./readerSessionRepository";
import { useApiHealth } from "./useApiHealth";

type PaneResizeState = {
  pane: "library" | "pins";
  startWidth: number;
  startX: number;
};
type MobilePanel = "library" | "pins" | null;
type VisibleCloudSyncStatus =
  | Exclude<CloudSyncStatus, "idle">
  | "checking"
  | "cloud-missing"
  | "offline";
type MathpixPipelineState = "idle" | "scheduled" | "running";
type MathpixProcessTone = "active" | "error" | "success";
type MathpixProcessStepState = "active" | "done" | "error" | "pending";
type MathpixProcessView = {
  activeStepIndex: number;
  detail: string;
  progressPercent: number;
  stepStates: MathpixProcessStepState[];
  title: string;
  tone: MathpixProcessTone;
};

const LIBRARY_PANE_DEFAULT_WIDTH = 240;
const LIBRARY_PANE_MAX_WIDTH = 380;
const LIBRARY_PANE_MIN_WIDTH = 180;
const PINS_PANE_DEFAULT_WIDTH = 280;
const PINS_PANE_MAX_WIDTH = 460;
const PINS_PANE_MIN_WIDTH = 300;
const TRANSLATION_CARD_BASE_Z_INDEX = 20;
const MATHPIX_BACKGROUND_PARSE_DELAY_MS = 2000;

function getHighestTranslationCardZIndex(
  cards: PinnedTranslationCard[],
  fallback = TRANSLATION_CARD_BASE_Z_INDEX,
) {
  return Math.max(
    TRANSLATION_CARD_BASE_Z_INDEX,
    fallback,
    ...cards.map((card) => card.zIndex),
  );
}

function getNextTranslationCardZIndex(
  cards: PinnedTranslationCard[],
  currentZIndex: number,
) {
  return getHighestTranslationCardZIndex(cards, currentZIndex) + 1;
}

const CLOUD_SYNC_STATUS_LABEL_KEYS: Record<VisibleCloudSyncStatus, MessageKey> = {
  "cloud-missing": "cloud.setup",
  "local-only": "cloud.localOnly",
  checking: "cloud.checking",
  offline: "cloud.offline",
  synced: "cloud.synced",
  syncing: "cloud.syncing",
};

function getVisibleCloudSyncMessage(
  status: VisibleCloudSyncStatus,
  latestSyncMessage: string,
  t: (key: MessageKey) => string,
) {
  switch (status) {
    case "checking":
      return t("cloud.checkingStatus");
    case "cloud-missing":
      return t("cloud.supabaseMissing");
    case "offline":
      return t("cloud.offlineMessage");
    case "synced":
      return latestSyncMessage || t("cloud.ready");
    case "syncing":
      return latestSyncMessage || t("cloud.syncingChanges");
    case "local-only":
      return latestSyncMessage || t("cloud.savedLocal");
    default:
      return t("cloud.ready");
  }
}

function getMathpixProcessView({
  formatNumber,
  pipelineState,
  record,
  runtimeError,
  t,
}: {
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  pipelineState: MathpixPipelineState;
  record?: MathpixDocumentRecord;
  runtimeError?: string;
  t: (key: MessageKey, values?: Record<string, number | string>) => string;
}): MathpixProcessView | undefined {
  if (runtimeError) {
    return {
      activeStepIndex: 1,
      detail: t("mathpix.failedDetailWithMessage", { message: runtimeError }),
      progressPercent: 100,
      stepStates: createMathpixStepStates(1, "error"),
      title: t("mathpix.failed"),
      tone: "error",
    };
  }

  if (!record) {
    if (pipelineState === "idle") {
      return undefined;
    }

    return {
      activeStepIndex: 0,
      detail: pipelineState === "scheduled"
        ? t("mathpix.startingDetail")
        : t("mathpix.uploadingDetail"),
      progressPercent: pipelineState === "scheduled" ? 4 : 8,
      stepStates: createMathpixStepStates(0, "active"),
      title: pipelineState === "scheduled" ? t("mathpix.starting") : t("mathpix.uploading"),
      tone: "active",
    };
  }

  if (record.status === "deleted") {
    return undefined;
  }

  if (record.status === "error") {
    return {
      activeStepIndex: 1,
      detail: record.errorMessage
        ? t("mathpix.failedDetailWithMessage", { message: record.errorMessage })
        : t("mathpix.failedDetail"),
      progressPercent: getMathpixRecordProgressPercent(record) ?? 100,
      stepStates: createMathpixStepStates(1, "error"),
      title: t("mathpix.failed"),
      tone: "error",
    };
  }

  if (record.status === "completed") {
    const isCaching = pipelineState === "running";

    return {
      activeStepIndex: isCaching ? 2 : 3,
      detail: isCaching
        ? t("mathpix.cachingDetail")
        : record.remoteDeletedAt
          ? t("mathpix.readyRemoteDeletedDetail")
          : t("mathpix.readyDetail"),
      progressPercent: isCaching ? 94 : 100,
      stepStates: createMathpixStepStates(isCaching ? 2 : 3, isCaching ? "active" : "success"),
      title: isCaching ? t("mathpix.caching") : t("mathpix.ready"),
      tone: isCaching ? "active" : "success",
    };
  }

  if (record.status === "processing") {
    const progressPercent = getMathpixRecordProgressPercent(record) ?? 34;

    return {
      activeStepIndex: 1,
      detail: getMathpixProgressDetail(record, progressPercent, formatNumber, t),
      progressPercent,
      stepStates: createMathpixStepStates(1, "active"),
      title: t("mathpix.processing"),
      tone: "active",
    };
  }

  const hasMathpixPdfId = Boolean(record.mathpixPdfId);

  return {
    activeStepIndex: hasMathpixPdfId ? 1 : 0,
    detail: hasMathpixPdfId ? t("mathpix.waitingDetail") : t("mathpix.uploadingDetail"),
    progressPercent: getMathpixRecordProgressPercent(record) ?? (hasMathpixPdfId ? 18 : 10),
    stepStates: createMathpixStepStates(hasMathpixPdfId ? 1 : 0, "active"),
    title: hasMathpixPdfId ? t("mathpix.waiting") : t("mathpix.uploading"),
    tone: "active",
  };
}

function getMathpixProgressDetail(
  record: MathpixDocumentRecord,
  progressPercent: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
  t: (key: MessageKey, values?: Record<string, number | string>) => string,
) {
  if (
    typeof record.numPages === "number" &&
    record.numPages > 0 &&
    typeof record.numPagesCompleted === "number"
  ) {
    return t("mathpix.processingPages", {
      completed: formatNumber(Math.min(record.numPagesCompleted, record.numPages)),
      total: formatNumber(record.numPages),
    });
  }

  return t("mathpix.processingPercent", {
    percent: formatNumber(Math.round(progressPercent)),
  });
}

function getCompactMathpixStatusLabel(
  view: MathpixProcessView,
  t: (key: MessageKey, values?: Record<string, number | string>) => string,
) {
  if (view.tone === "success") {
    return t("mathpix.compact.ready");
  }

  if (view.tone === "error") {
    return t("mathpix.compact.failed");
  }

  return t("mathpix.compact.progress", {
    percent: Math.round(view.progressPercent),
  });
}

function getMathpixRecordProgressPercent(record: MathpixDocumentRecord) {
  if (record.status === "completed") {
    return 100;
  }

  const normalizedPercent = normalizeMathpixPercent(record.percentDone);

  if (typeof normalizedPercent === "number") {
    return normalizedPercent;
  }

  if (
    typeof record.numPages === "number" &&
    record.numPages > 0 &&
    typeof record.numPagesCompleted === "number"
  ) {
    return clamp((record.numPagesCompleted / record.numPages) * 100, 0, 100);
  }

  return undefined;
}

function normalizeMathpixPercent(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return clamp(value <= 1 ? value * 100 : value, 0, 100);
}

function createMathpixStepStates(
  activeStepIndex: number,
  tone: MathpixProcessTone,
): MathpixProcessStepState[] {
  return [0, 1, 2, 3].map((stepIndex) => {
    if (tone === "success") {
      return "done";
    }

    if (tone === "error" && stepIndex === activeStepIndex) {
      return "error";
    }

    if (stepIndex < activeStepIndex) {
      return "done";
    }

    if (stepIndex === activeStepIndex) {
      return "active";
    }

    return "pending";
  });
}

export function ReaderShell() {
  const auth = useAuth();
  const readerSessionUserId = auth.user?.id;
  const health = useApiHealth();
  const apiStatus = health.status === "ok" ? "online" : health.status;
  const isSupabaseConfigured = health.status === "ok" ? health.data.supabase.configured : false;
  const [libraryEntries, setLibraryEntries] = useState<CloudPdfLibraryEntry[]>([]);
  const [isLibraryLoaded, setIsLibraryLoaded] = useState(false);
  const [currentEntry, setCurrentEntry] = useState<PdfLibraryEntry>();
  const [isImporting, setIsImporting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLibraryPaneOpen, setIsLibraryPaneOpen] = useState(true);
  const [isPinsPaneOpen, setIsPinsPaneOpen] = useState(true);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const [libraryPaneWidth, setLibraryPaneWidth] = useState(LIBRARY_PANE_DEFAULT_WIDTH);
  const [isConfirmingClearPins, setIsConfirmingClearPins] = useState(false);
  const [pinPanelFocusRequest, setPinPanelFocusRequest] = useState<PinPanelFocusRequest>();
  const [locateRequest, setLocateRequest] = useState<PinLocateRequest>();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [pinsPaneWidth, setPinsPaneWidth] = useState(PINS_PANE_DEFAULT_WIDTH);
  const [isPaneResizing, setIsPaneResizing] = useState(false);
  const [paperContext, setPaperContext] = useState<PaperContextRecord>();
  const [mathpixParsedPages, setMathpixParsedPages] = useState<Map<number, MathpixParsedPage>>(
    () => new Map(),
  );
  const [pins, setPins] = useState<TranslationPin[]>([]);
  const [pinnedTranslationCards, setPinnedTranslationCards] = useState<PinnedTranslationCard[]>([]);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("continuous");
  const [mobileInteractionMode, setMobileInteractionMode] =
    useState<MobileInteractionMode>("pan");
  const [sentenceSelection, setSentenceSelection] = useState<SentenceSelection>();
  const [activeTranslationCardZIndex, setActiveTranslationCardZIndex] = useState(
    TRANSLATION_CARD_BASE_Z_INDEX,
  );
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [statusMessage, setStatusMessage] = useState<string>();
  const [isExporting, setIsExporting] = useState(false);
  const [cloudSyncMessage, setCloudSyncMessage] = useState("");
  const [cloudSyncStatus, setCloudSyncStatus] = useState<CloudSyncStatus>("idle");
  const { formatNumber, t } = useMemo(() => createI18n(settings.uiLocale), [settings.uiLocale]);
  const [damagedLibraryFingerprint, setDamagedLibraryFingerprint] = useState<string>();
  const [mathpixRecord, setMathpixRecord] = useState<MathpixDocumentRecord>();
  const [mathpixPipelineState, setMathpixPipelineState] =
    useState<MathpixPipelineState>("idle");
  const [mathpixRuntimeError, setMathpixRuntimeError] = useState<string>();
  const [readerSessionHydratedUserId, setReaderSessionHydratedUserId] = useState<string>();
  const activeReaderSessionUserIdRef = useRef<string>();
  const activeFingerprintRef = useRef<string>();
  const autoRestoreUserIdRef = useRef<string>();
  const locateRequestIdRef = useRef(0);
  const paneResizeStateRef = useRef<PaneResizeState>();
  const pinPanelFocusRequestIdRef = useRef(0);
  const pinsRef = useRef<TranslationPin[]>([]);
  const pinnedTranslationCardSaveTimersRef = useRef(new Map<string, number>());
  const pinnedTranslationCardsRef = useRef<PinnedTranslationCard[]>([]);
  const mathpixParsedPagesRef = useRef(new Map<number, MathpixParsedPage>());
  const translationCardZIndexRef = useRef(TRANSLATION_CARD_BASE_Z_INDEX);
  const activeFingerprint = currentEntry?.fingerprint;
  const currentFileName = currentEntry?.fileName;
  const currentMetadataTitle = currentEntry?.pdfMetadata?.title;
  const paperContextPageTextsRef = useRef(new Map<number, string>());
  const visibleCloudSyncStatus: VisibleCloudSyncStatus =
    health.status === "checking"
      ? "checking"
      : health.status === "offline"
        ? "offline"
        : isSupabaseConfigured
          ? cloudSyncStatus === "idle" ? "synced" : cloudSyncStatus
          : "cloud-missing";
  const visibleCloudSyncMessage = getVisibleCloudSyncMessage(
    visibleCloudSyncStatus,
    cloudSyncMessage,
    t,
  );
  const mobileStatusLabel = t("reader.mobileStatus", {
    apiStatus,
    syncMessage: visibleCloudSyncMessage,
  });
  const mathpixProcessView = getMathpixProcessView({
    formatNumber,
    pipelineState: mathpixPipelineState,
    record: mathpixRecord,
    runtimeError: mathpixRuntimeError,
    t,
  });

  useEffect(() => {
    activeFingerprintRef.current = activeFingerprint;
  }, [activeFingerprint]);

  const applyPinnedTranslationCards = useCallback((nextCards: PinnedTranslationCard[]) => {
    pinnedTranslationCardsRef.current = nextCards;
    setPinnedTranslationCards(nextCards);
  }, []);

  const replacePinnedTranslationCards = useCallback((nextCards: PinnedTranslationCard[]) => {
    const nextZIndex = getHighestTranslationCardZIndex(nextCards);

    translationCardZIndexRef.current = nextZIndex;
    setActiveTranslationCardZIndex(nextZIndex);
    applyPinnedTranslationCards(nextCards);
  }, [applyPinnedTranslationCards]);

  const applyMathpixParsedPages = useCallback((pages: MathpixParsedPage[]) => {
    const nextPages = mapPagesByIndex(pages);

    mathpixParsedPagesRef.current = nextPages;
    setMathpixParsedPages(nextPages);
  }, []);

  const updatePinnedTranslationCards = useCallback(
    (updater: (currentCards: PinnedTranslationCard[]) => PinnedTranslationCard[]) => {
      const nextCards = updater(pinnedTranslationCardsRef.current);

      applyPinnedTranslationCards(nextCards);

      return nextCards;
    },
    [applyPinnedTranslationCards],
  );

  const clearPinnedTranslationCardSaveTimer = useCallback((cardKey: string) => {
    const timer = pinnedTranslationCardSaveTimersRef.current.get(cardKey);

    if (timer) {
      window.clearTimeout(timer);
      pinnedTranslationCardSaveTimersRef.current.delete(cardKey);
    }
  }, []);

  const persistPinnedTranslationCard = useCallback(
    (card: PinnedTranslationCard, options: { debounce?: boolean } = {}) => {
      clearPinnedTranslationCardSaveTimer(card.key);

      const saveCard = () => {
        pinnedTranslationCardSaveTimersRef.current.delete(card.key);
        void putPinnedTranslationCard(card).catch(() => {
          setStatusMessage("Could not save pinned translation card.");
        });
      };

      if (options.debounce) {
        const timer = window.setTimeout(saveCard, 250);

        pinnedTranslationCardSaveTimersRef.current.set(card.key, timer);
        return;
      }

      saveCard();
    },
    [clearPinnedTranslationCardSaveTimer],
  );

  const refreshLibrary = useCallback(async () => {
    const entries = await listCloudPdfLibraryEntries();

    setLibraryEntries(entries);
    setIsLibraryLoaded(true);

    return entries;
  }, []);

  useEffect(() => {
    setIsLibraryLoaded(false);
    void refreshLibrary().catch(() => {
      setStatusMessage("Could not read the local PDF library.");
    });
  }, [readerSessionUserId, refreshLibrary]);

  useEffect(() => {
    if (!readerSessionUserId) {
      setReaderSessionHydratedUserId(undefined);
      return;
    }

    if (
      activeReaderSessionUserIdRef.current &&
      activeReaderSessionUserIdRef.current !== readerSessionUserId
    ) {
      autoRestoreUserIdRef.current = undefined;
      setCurrentEntry(undefined);
      setSentenceSelection(undefined);
      replacePinnedTranslationCards([]);
      setPins([]);
      setLibraryEntries([]);
      setIsLibraryLoaded(false);
    }

    activeReaderSessionUserIdRef.current = readerSessionUserId;
    const savedSession = getReaderSession(readerSessionUserId);

    setIsLibraryPaneOpen(savedSession?.isLibraryPaneOpen ?? true);
    setIsPinsPaneOpen(savedSession?.isPinsPaneOpen ?? true);
    setLibraryPaneWidth(clamp(
      savedSession?.libraryPaneWidth ?? LIBRARY_PANE_DEFAULT_WIDTH,
      LIBRARY_PANE_MIN_WIDTH,
      LIBRARY_PANE_MAX_WIDTH,
    ));
    setPinsPaneWidth(clamp(
      savedSession?.pinsPaneWidth ?? PINS_PANE_DEFAULT_WIDTH,
      PINS_PANE_MIN_WIDTH,
      PINS_PANE_MAX_WIDTH,
    ));
    setSelectionMode(savedSession?.selectionMode ?? "continuous");
    setMobileInteractionMode(savedSession?.mobileInteractionMode ?? "pan");
    setReaderSessionHydratedUserId(readerSessionUserId);
  }, [readerSessionUserId, replacePinnedTranslationCards]);

  useEffect(() => {
    if (
      !readerSessionUserId ||
      readerSessionHydratedUserId !== readerSessionUserId
    ) {
      return;
    }

    updateReaderSession(readerSessionUserId, {
      isLibraryPaneOpen,
      isPinsPaneOpen,
      libraryPaneWidth,
      mobileInteractionMode,
      pinsPaneWidth,
      selectionMode,
    });
  }, [
    isLibraryPaneOpen,
    isPinsPaneOpen,
    libraryPaneWidth,
    mobileInteractionMode,
    pinsPaneWidth,
    readerSessionHydratedUserId,
    readerSessionUserId,
    selectionMode,
  ]);

  useEffect(() => {
    if (
      !readerSessionUserId ||
      readerSessionHydratedUserId !== readerSessionUserId ||
      !currentEntry
    ) {
      return;
    }

    updateReaderSession(readerSessionUserId, {
      activeCloudDocumentId: currentEntry.cloudDocumentId,
      activeFingerprint: currentEntry.fingerprint,
    });
  }, [
    currentEntry?.cloudDocumentId,
    currentEntry?.fingerprint,
    readerSessionHydratedUserId,
    readerSessionUserId,
  ]);

  useEffect(() => {
    const handleCloudSyncError = (event: Event) => {
      setStatusMessage(getCloudSyncErrorMessage(event));
    };

    window.addEventListener(CLOUD_SYNC_ERROR_EVENT, handleCloudSyncError);

    return () => {
      window.removeEventListener(CLOUD_SYNC_ERROR_EVENT, handleCloudSyncError);
    };
  }, []);

  useEffect(() => {
    const handleCloudSyncStatus = (event: Event) => {
      const detail = getCloudSyncStatusDetail(event);

      setCloudSyncStatus(detail.status);
      setCloudSyncMessage(detail.message);
    };

    window.addEventListener(CLOUD_SYNC_STATUS_EVENT, handleCloudSyncStatus);

    return () => {
      window.removeEventListener(CLOUD_SYNC_STATUS_EVENT, handleCloudSyncStatus);
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 920px)");
    const updateViewportState = () => {
      setIsNarrowViewport(mediaQuery.matches);
    };

    updateViewportState();
    mediaQuery.addEventListener("change", updateViewportState);

    return () => {
      mediaQuery.removeEventListener("change", updateViewportState);
    };
  }, []);

  useEffect(() => {
    if (!isNarrowViewport) {
      setMobilePanel(null);
    }
  }, [isNarrowViewport]);

  useEffect(() => {
    if (!mobilePanel) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobilePanel(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobilePanel]);

  useEffect(() => {
    void getAppSettings()
      .then(setSettings)
      .catch(() => {
        setStatusMessage("Could not read saved settings.");
      });
  }, []);

  useEffect(() => {
    pinsRef.current = pins;
    if (pins.length === 0) {
      setIsConfirmingClearPins(false);
    }
  }, [pins]);

  useEffect(() => {
    return () => {
      for (const timer of pinnedTranslationCardSaveTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      pinnedTranslationCardSaveTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeFingerprint) {
      paperContextPageTextsRef.current = new Map();
      mathpixParsedPagesRef.current = new Map();
      setPaperContext(undefined);
      setMathpixParsedPages(new Map());
      setMathpixPipelineState("idle");
      setMathpixRecord(undefined);
      setMathpixRuntimeError(undefined);
      setPins([]);
      replacePinnedTranslationCards([]);
      setIsConfirmingClearPins(false);
      return undefined;
    }

    paperContextPageTextsRef.current = new Map();
    mathpixParsedPagesRef.current = new Map();
    setMathpixParsedPages(new Map());
    setMathpixRecord(undefined);
    setMathpixRuntimeError(undefined);
    replacePinnedTranslationCards([]);
    setIsConfirmingClearPins(false);
    let cancelled = false;

    if (currentEntry) {
      void getMathpixDocumentRecord(activeFingerprint)
        .then((record) => {
          if (!cancelled && record && isMathpixRecordCurrentForEntry(record, currentEntry)) {
            setMathpixRecord(record);
          }
        })
        .catch(() => undefined);

      void ensurePaperContextForEntry(currentEntry)
        .then((record) => {
          if (!cancelled) {
            setPaperContext(record);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setStatusMessage("Could not read paper context for this PDF.");
          }
        });
    }

    void listPinsByPdf(activeFingerprint)
      .then((loadedPins) => {
        if (!cancelled) {
          setPins((currentPins) =>
            mergePins(
              currentPins.filter((pin) => pin.pdfFingerprint === activeFingerprint),
              loadedPins,
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPins([]);
          setStatusMessage("Could not read saved annotations for this PDF.");
        }
      });

    void listPinnedTranslationCardsByPdf(activeFingerprint)
      .then((loadedCards) => {
        if (!cancelled) {
          replacePinnedTranslationCards(loadedCards);
        }
      })
      .catch(() => {
        if (!cancelled) {
          replacePinnedTranslationCards([]);
          setStatusMessage("Could not read pinned translation cards for this PDF.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeFingerprint,
    currentEntry?.cloudDocumentId,
    currentEntry?.contentSha256,
    currentEntry?.fileName,
    currentEntry?.fileSize,
    currentEntry?.fingerprint,
    currentEntry?.pdfMetadata?.title,
    replacePinnedTranslationCards,
  ]);

  useEffect(() => {
    if (!currentEntry) {
      return undefined;
    }

    const abortController = new AbortController();
    setMathpixPipelineState("scheduled");
    setMathpixRuntimeError(undefined);
    const parseTimer = window.setTimeout(() => {
      if (abortController.signal.aborted || currentEntry.fingerprint !== activeFingerprintRef.current) {
        return;
      }

      setMathpixPipelineState("running");
      void runMathpixParsePipeline({
        entry: currentEntry,
        onPages: (pages) => {
          if (abortController.signal.aborted || currentEntry.fingerprint !== activeFingerprintRef.current) {
            return;
          }

          applyMathpixParsedPages(pages);

          const pageTexts = pages
            .slice(0, PROJECT_CONFIG.paperContext.maxScanPages)
            .map((page) => page.pageText)
            .filter((text) => text.trim().length > 0);

          if (pageTexts.length > 0) {
            void updatePaperContextFromPageTexts({
              fileName: currentEntry.fileName,
              metadataTitle: currentEntry.pdfMetadata?.title,
              pageTexts,
              cloudDocumentId: currentEntry.cloudDocumentId,
              pdfFingerprint: currentEntry.fingerprint,
            })
              .then((record) => {
                setPaperContext((currentRecord) =>
                  currentRecord?.pdfFingerprint === record.pdfFingerprint &&
                  currentRecord.contextHash === record.contextHash
                    ? currentRecord
                    : record,
                );
              })
              .catch(() => undefined);
          }
        },
        onRecord: (record) => {
          if (abortController.signal.aborted || record.pdfFingerprint !== activeFingerprintRef.current) {
            return;
          }

          setMathpixRuntimeError(undefined);
          setMathpixRecord(record);
        },
        signal: abortController.signal,
      })
        .catch((error) => {
          if (isAbortError(error)) {
            return;
          }

          if (!abortController.signal.aborted && currentEntry.fingerprint === activeFingerprintRef.current) {
            const message =
              error instanceof Error
                ? error.message
                : "MathPix parsing failed.";

            setMathpixRuntimeError(message);
            setStatusMessage(`MathPix parsing failed. Using PDF text fallback. ${message}`);
          }
        })
        .finally(() => {
          if (currentEntry.fingerprint === activeFingerprintRef.current) {
            setMathpixPipelineState("idle");
          }
        });
    }, MATHPIX_BACKGROUND_PARSE_DELAY_MS);

    return () => {
      window.clearTimeout(parseTimer);
      abortController.abort();
      if (currentEntry.fingerprint === activeFingerprintRef.current) {
        setMathpixPipelineState("idle");
      }
    };
  }, [
    activeFingerprint,
    applyMathpixParsedPages,
    currentEntry?.blob,
    currentEntry?.cloudDocumentId,
    currentEntry?.contentSha256,
    currentEntry?.fileName,
    currentEntry?.fileSize,
    currentEntry?.fingerprint,
    currentEntry?.pdfMetadata?.title,
  ]);

  const handleImport = useCallback(
    async (file: File) => {
      setIsImporting(true);
      setStatusMessage(undefined);
      setDamagedLibraryFingerprint(undefined);

      try {
        let entry: PdfLibraryEntry;

        if (isDocumentArchiveFile(file)) {
          const archive = await parseDocumentArchive(file);
          const identity = await createPdfFingerprint(archive.pdfFile);
          const expectedContentSha256 = archive.manifest.document.contentSha256;

          if (expectedContentSha256 && expectedContentSha256 !== identity.contentSha256) {
            throw new Error("The reading package PDF does not match its saved content hash.");
          }

          entry = await importPdfToCloud(archive.pdfFile, {
            ...identity,
            fileName: archive.manifest.document.fileName || identity.fileName,
            pdfMetadata: identity.pdfMetadata ?? archive.manifest.document.pdfMetadata,
          });

          if (entry.cloudDocumentId) {
            await hydrateCloudDocumentState(entry.cloudDocumentId, entry.fingerprint).catch(() => {
              setStatusMessage("Could not sync cloud document state.");
            });
          }

          entry = await applyArchiveReadingPosition(entry, archive.manifest.document);
          await importDocumentArchiveState({
            entry,
            mode: "merge",
            state: archive.manifest.state,
          });
        } else {
          const identity = await createPdfFingerprint(file);

          entry = await saveImportedPdf({
            blob: file.slice(0, file.size, "application/pdf"),
            ...identity,
          });

          void importPdfToCloud(file, identity)
            .then(async (cloudEntry) => {
              if (cloudEntry.cloudDocumentId) {
                await hydrateCloudDocumentState(cloudEntry.cloudDocumentId, cloudEntry.fingerprint).catch(() => {
                  setStatusMessage("Could not sync cloud document state.");
                });
              }

              setCurrentEntry((current) =>
                current?.fingerprint === cloudEntry.fingerprint
                  ? { ...current, ...cloudEntry }
                  : current,
              );
              await refreshLibrary();
            })
            .catch((error) => {
              setStatusMessage(getStorageErrorMessage(error, "PDF opened locally, but cloud upload failed."));
            });
        }

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
        setMobilePanel(null);
        replacePinnedTranslationCards([]);
        setPins([]);
        void refreshLibrary().catch(() => {
          setStatusMessage("Could not refresh the PDF library.");
        });
      } catch (error) {
        setStatusMessage(getStorageErrorMessage(error, "Could not import this PDF."));
      } finally {
        setIsImporting(false);
      }
    },
    [refreshLibrary, replacePinnedTranslationCards],
  );

  const handleOpenHistory = useCallback(
    async (entry: CloudPdfLibraryEntry) => {
      setStatusMessage(undefined);
      setDamagedLibraryFingerprint(undefined);

      try {
        const openedEntry = await openCloudPdfDocument(entry.cloudDocumentId);

        setCurrentEntry(openedEntry);
        setSentenceSelection(undefined);
        setMobilePanel(null);
        replacePinnedTranslationCards([]);
        setPins([]);
        void refreshLibrary().catch(() => {
          setStatusMessage("Could not refresh the PDF library.");
        });

        if (openedEntry.cloudDocumentId) {
          void hydrateCloudDocumentState(openedEntry.cloudDocumentId, openedEntry.fingerprint)
            .then((state) => {
              setCurrentEntry((current) =>
                current?.fingerprint === openedEntry.fingerprint
                  ? { ...current, cloudDocumentId: openedEntry.cloudDocumentId }
                  : current,
              );
              setPaperContext((current) =>
                current?.pdfFingerprint === openedEntry.fingerprint
                  ? current
                  : state.paperContext,
              );
              setPins((currentPins) =>
                mergePins(
                  currentPins.filter((pin) => pin.pdfFingerprint === openedEntry.fingerprint),
                  state.pins,
                ),
              );
              replacePinnedTranslationCards(state.pinnedTranslationCards);
            })
            .catch(() => {
              setStatusMessage("Could not sync cloud document state.");
            });
        }
      } catch (error) {
        setDamagedLibraryFingerprint(entry.fingerprint);
        setStatusMessage(
          error instanceof Error
            ? `${error.message} Try opening it again or remove the cloud PDF record.`
            : "Could not open this PDF. Try opening it again or remove the cloud PDF record.",
        );
      }
    },
    [refreshLibrary, replacePinnedTranslationCards],
  );

  useEffect(() => {
    if (
      !readerSessionUserId ||
      readerSessionHydratedUserId !== readerSessionUserId ||
      !isLibraryLoaded ||
      autoRestoreUserIdRef.current === readerSessionUserId
    ) {
      return;
    }

    if (currentEntry) {
      autoRestoreUserIdRef.current = readerSessionUserId;
      return;
    }

    const savedSession = getReaderSession(readerSessionUserId);
    const savedEntry = savedSession
      ? libraryEntries.find((entry) =>
        entry.cloudDocumentId === savedSession.activeCloudDocumentId ||
        entry.fingerprint === savedSession.activeFingerprint
      )
      : undefined;
    const restoreEntry = savedEntry ?? getLatestLibraryEntry(libraryEntries);

    autoRestoreUserIdRef.current = readerSessionUserId;

    if (!restoreEntry) {
      return;
    }

    void handleOpenHistory(restoreEntry);
  }, [
    currentEntry,
    handleOpenHistory,
    isLibraryLoaded,
    libraryEntries,
    readerSessionHydratedUserId,
    readerSessionUserId,
  ]);

  const handleDocumentLoadError = useCallback(
    (fingerprint: string, message: string) => {
      setDamagedLibraryFingerprint(fingerprint);
      setStatusMessage(message);
    },
    [],
  );

  const handleReadingPositionChange = useCallback(
    (position: ReadingPositionUpdate) => {
      if (!activeFingerprint) {
        return;
      }

      setCurrentEntry((entry) =>
        entry?.fingerprint === activeFingerprint
          ? { ...entry, ...position }
          : entry,
      );

      if (!currentEntry?.cloudDocumentId) {
        return;
      }

      void updateCloudReadingPosition(currentEntry.cloudDocumentId, position).then((updatedEntry) => {
        setCurrentEntry((entry) =>
          entry?.cloudDocumentId === updatedEntry.cloudDocumentId
            ? { ...entry, ...position, lastOpenedAt: updatedEntry.lastOpenedAt }
            : entry,
        );
        setLibraryEntries((entries) =>
          entries.map((entry) =>
            entry.cloudDocumentId === updatedEntry.cloudDocumentId
              ? { ...entry, ...updatedEntry }
              : entry,
          ),
        );
      }).catch(() => {
        setStatusMessage("Could not sync reading position.");
      });
    },
    [activeFingerprint, currentEntry?.cloudDocumentId],
  );

  const handleCloseTranslationCard = useCallback((selection: SentenceSelection) => {
    const targetKey = createPinTargetKey(selection);

    window.getSelection()?.removeAllRanges();
    setSentenceSelection((currentSelection) =>
      currentSelection && isSamePinTarget(currentSelection, selection) ? undefined : currentSelection,
    );
    clearPinnedTranslationCardSaveTimer(targetKey);
    updatePinnedTranslationCards((currentCards) =>
      currentCards.filter((currentCard) => currentCard.key !== targetKey),
    );
    void deletePinnedTranslationCard(targetKey, selection.cloudDocumentId ?? currentEntry?.cloudDocumentId).catch(() => {
      setStatusMessage("Could not remove pinned translation card.");
    });
  }, [clearPinnedTranslationCardSaveTimer, currentEntry?.cloudDocumentId, updatePinnedTranslationCards]);

  const handlePinTranslationCard = useCallback((input: TranslationCardPinInput) => {
    const targetKey = createPinTargetKey(input.selection);
    const currentCards = pinnedTranslationCardsRef.current;

    if (currentCards.some((currentCard) => currentCard.key === targetKey)) {
      clearPinnedTranslationCardSaveTimer(targetKey);
      updatePinnedTranslationCards((cards) =>
        cards.filter((currentCard) => currentCard.key !== targetKey),
      );
      void deletePinnedTranslationCard(
        targetKey,
        input.selection.cloudDocumentId ?? currentEntry?.cloudDocumentId,
      ).catch(() => {
        setStatusMessage("Could not remove pinned translation card.");
      });
      return;
    }

    const nextZIndex = getNextTranslationCardZIndex(
      currentCards,
      translationCardZIndexRef.current,
    );
    const nextCard: PinnedTranslationCard = {
      ...input,
      cloudDocumentId: input.cloudDocumentId ?? input.selection.cloudDocumentId ?? currentEntry?.cloudDocumentId,
      key: targetKey,
      zIndex: nextZIndex,
    };

    translationCardZIndexRef.current = nextZIndex;
    updatePinnedTranslationCards((cards) => [...cards, nextCard]);
    persistPinnedTranslationCard(nextCard);
  }, [
    clearPinnedTranslationCardSaveTimer,
    currentEntry?.cloudDocumentId,
    persistPinnedTranslationCard,
    updatePinnedTranslationCards,
  ]);

  const handleActivateTranslationCard = useCallback((selection: SentenceSelection) => {
    const nextZIndex = getNextTranslationCardZIndex(
      pinnedTranslationCardsRef.current,
      translationCardZIndexRef.current,
    );
    let updatedCard: PinnedTranslationCard | undefined;

    translationCardZIndexRef.current = nextZIndex;
    setActiveTranslationCardZIndex(nextZIndex);
    updatePinnedTranslationCards((currentCards) =>
      currentCards.map((currentCard) => {
        if (!isSamePinTarget(currentCard.selection, selection)) {
          return currentCard;
        }

        updatedCard = {
          ...currentCard,
          zIndex: nextZIndex,
        };

        return updatedCard;
      }),
    );

    if (updatedCard) {
      clearPinnedTranslationCardSaveTimer(updatedCard.key);
      persistPinnedTranslationCard(updatedCard, { debounce: true });
    }
  }, [clearPinnedTranslationCardSaveTimer, persistPinnedTranslationCard, updatePinnedTranslationCards]);

  const handleTranslationCardViewChange = useCallback(
    (
      selection: SentenceSelection,
      viewChange: TranslationCardViewChange,
      options: TranslationCardViewChangeOptions = {},
    ) => {
      let updatedCard: PinnedTranslationCard | undefined;

      updatePinnedTranslationCards((currentCards) =>
        currentCards.map((currentCard) => {
          if (!isSamePinTarget(currentCard.selection, selection)) {
            return currentCard;
          }

          updatedCard = {
            ...currentCard,
            view: {
              ...currentCard.view,
              ...viewChange,
            },
          };

          return updatedCard;
        }),
      );

      if (updatedCard && options.committed) {
        persistPinnedTranslationCard(updatedCard);
      }
    },
    [persistPinnedTranslationCard, updatePinnedTranslationCards],
  );

  const handleSentenceSelectionChange = useCallback((selection: SentenceSelection | undefined) => {
    const resolvedSelection = selection && settings.textSelectionMode === "mathpix"
      ? resolveMathpixSelectionText({
          parsedPages: mathpixParsedPagesRef.current,
          selection,
        })
      : selection;

    setSentenceSelection(resolvedSelection);

    if (!resolvedSelection) {
      return;
    }

    const nextZIndex = getNextTranslationCardZIndex(
      pinnedTranslationCardsRef.current,
      translationCardZIndexRef.current,
    );

    translationCardZIndexRef.current = nextZIndex;
    setActiveTranslationCardZIndex(nextZIndex);
  }, [settings.textSelectionMode]);

  useEffect(() => {
    if (
      settings.textSelectionMode !== "mathpix" ||
      !sentenceSelection ||
      sentenceSelection.textSource === "mathpix-v3-pdf" ||
      mathpixParsedPages.size === 0
    ) {
      return;
    }

    const resolvedSelection = resolveMathpixSelectionText({
      parsedPages: mathpixParsedPages,
      selection: sentenceSelection,
    });

    if (resolvedSelection.textSource === "mathpix-v3-pdf") {
      setSentenceSelection(resolvedSelection);
    }
  }, [mathpixParsedPages, sentenceSelection, settings.textSelectionMode]);

  const handleSelectionModeChange = useCallback((nextMode: SelectionMode) => {
    setSelectionMode(nextMode);
    setSentenceSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleMobileInteractionModeToggle = useCallback(() => {
    setMobileInteractionMode((currentMode) =>
      currentMode === "pan" ? "segmented" : "pan",
    );
    setSentenceSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handlePinTranslation = useCallback(async (
    input: PinWriteInput,
    action: TranslationFavoriteAction,
  ) => {
    if (action === "remove") {
      const existingPin = pinsRef.current.find((pin) => isSamePinTarget(pin, input.selection));

      if (!existingPin) {
        setPins((currentPins) =>
          currentPins.filter((currentPin) => !isSamePinTarget(currentPin, input.selection)),
        );
        return;
      }

      try {
        await deletePin(existingPin.id);
        setPins((currentPins) =>
          currentPins.filter((currentPin) => !isSamePinTarget(currentPin, input.selection)),
        );
      } catch (error) {
        setStatusMessage("Could not remove this annotation.");
        throw error;
      }
      return;
    }

    try {
      const pin = await putPin(input);

      setPins((currentPins) => upsertPin(currentPins, pin));
    } catch (error) {
      setStatusMessage("Could not save this annotation.");
      throw error;
    }
  }, []);

  const handlePinnedTranslationRefresh = useCallback((input: PinWriteInput) => {
    const existingPin = pinsRef.current.find((pin) => isSamePinTarget(pin, input.selection));

    if (!existingPin) {
      return;
    }

    void updatePinTranslation(existingPin.id, {
      cacheKey: input.cacheKey,
      model: input.model,
      translation: input.translation,
    })
      .then((pin) => {
        if (pin) {
          setPins((currentPins) => upsertPin(currentPins, pin));
        }
      })
      .catch(() => {
        setStatusMessage("Could not update this annotation.");
      });
  }, []);

  const handleCreateAnnotation = useCallback(async (
    selection: SentenceSelection,
    annotation: PinAnnotationInput,
  ) => {
    try {
      const pin = await putPin({
        annotation,
        contextWindowN: settings.contextWindowN,
        longContextEnabled: settings.longContextEnabled,
        model: settings.defaultModel,
        pageHeight: selection.pageHeight,
        pageWidth: selection.pageWidth,
        promptVersion: TRANSLATION_PROMPT_VERSION,
        selection,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
        translation: "",
      });

      setPins((currentPins) => upsertPin(currentPins, pin));
    } catch (error) {
      setStatusMessage("Could not save annotation.");
      throw error;
    }
  }, [settings]);

  const handlePinAnnotation = useCallback(async (
    pin: TranslationPin,
    annotation: PinAnnotationInput,
  ) => {
    try {
      const updatedPin = await updatePinAnnotation(pin.id, annotation);

      if (updatedPin) {
        setPins((currentPins) => upsertPin(currentPins, updatedPin));
      }
    } catch (error) {
      setStatusMessage("Could not update annotation.");
      throw error;
    }
  }, []);

  const handlePinUpdated = useCallback((pin: TranslationPin) => {
    setPins((currentPins) => upsertPin(currentPins, pin));
  }, []);

  const handlePinHighlight = useCallback((pin: TranslationPin, highlighted: boolean) => {
    void updatePinHighlight(pin.id, highlighted)
      .then((updatedPin) => {
        if (updatedPin) {
          setPins((currentPins) => upsertPin(currentPins, updatedPin));
        }
      })
      .catch(() => {
        setStatusMessage("Could not update annotation highlight.");
      });
  }, []);

  const handleUnpin = useCallback((pin: TranslationPin) => {
    void deletePin(pin.id)
      .then(() => {
        setPins((currentPins) => currentPins.filter((currentPin) => !isSamePinTarget(currentPin, pin)));
      })
      .catch(() => {
        setStatusMessage("Could not remove this annotation.");
      });
  }, []);

  const handleSettingsChange = useCallback(async (nextSettings: Partial<AppSettings>) => {
    const updatedSettings = await putAppSettings(nextSettings);

    setSettings(updatedSettings);
  }, []);

  const handlePaperContextSave = useCallback(
    async (draft: PaperContextDraft) => {
      if (!activeFingerprint) {
        return;
      }

      const updatedRecord = await saveUserPaperContext(
        activeFingerprint,
        draft,
        currentEntry?.cloudDocumentId,
      );

      setPaperContext(updatedRecord);
    },
    [activeFingerprint, currentEntry?.cloudDocumentId],
  );

  const handlePageTextReadyForPaperContext = useCallback(
    (pageIndex: number, text: string) => {
      if (
        !activeFingerprint ||
        pageIndex >= PROJECT_CONFIG.paperContext.maxScanPages
      ) {
        return;
      }

      const previousText = paperContextPageTextsRef.current.get(pageIndex);

      if (previousText === text) {
        return;
      }

      paperContextPageTextsRef.current.set(pageIndex, text);
      const pageTexts = Array.from(paperContextPageTextsRef.current.entries())
        .sort(([leftPageIndex], [rightPageIndex]) => leftPageIndex - rightPageIndex)
        .map(([, pageText]) => pageText);

      void updatePaperContextFromPageTexts({
        fileName: currentFileName,
        metadataTitle: currentMetadataTitle,
        pageTexts,
        cloudDocumentId: currentEntry?.cloudDocumentId,
        pdfFingerprint: activeFingerprint,
      })
        .then((record) => {
          setPaperContext((currentRecord) =>
            currentRecord?.pdfFingerprint === record.pdfFingerprint &&
            currentRecord.contextHash === record.contextHash
              ? currentRecord
              : record,
          );
        })
        .catch(() => {
          setStatusMessage("Could not update paper context from PDF text.");
        });
    },
    [activeFingerprint, currentEntry?.cloudDocumentId, currentFileName, currentMetadataTitle],
  );

  const handleClearCurrentPdfPins = useCallback(async () => {
    if (!activeFingerprint) {
      return;
    }

    await deletePinsByPdf(activeFingerprint);
    setPins([]);
    setIsConfirmingClearPins(false);
  }, [activeFingerprint]);

  const handleClearPins = useCallback(() => {
    void handleClearCurrentPdfPins().catch(() => {
      setStatusMessage("Could not clear annotations for this PDF.");
    });
  }, [handleClearCurrentPdfPins]);

  const handleClearTranslationCache = useCallback(async () => {
    await clearTranslationCache();
  }, []);

  const flushPinnedTranslationCards = useCallback(async () => {
    const cards = pinnedTranslationCardsRef.current;

    for (const card of cards) {
      clearPinnedTranslationCardSaveTimer(card.key);
    }

    await Promise.all(cards.map((card) => putPinnedTranslationCard(card)));
  }, [clearPinnedTranslationCardSaveTimer]);

  const handleExportPdf = useCallback(() => {
    if (!currentEntry) {
      return;
    }

    downloadBlob(currentEntry.blob, currentEntry.fileName);
  }, [currentEntry]);

  const handleExportReadingPackage = useCallback(async () => {
    if (!currentEntry) {
      return;
    }

    setIsExporting(true);
    setStatusMessage(undefined);

    try {
      await flushPinnedTranslationCards();
      const archive = await createDocumentArchive(currentEntry);

      downloadBlob(archive, replaceFileExtension(currentEntry.fileName, ".ptrx"));
    } catch (error) {
      setStatusMessage(getStorageErrorMessage(error, "Could not export this reading package."));
    } finally {
      setIsExporting(false);
    }
  }, [currentEntry, flushPinnedTranslationCards]);

  const handleDeletePdfData = useCallback(
    async (target: CloudPdfLibraryEntry | PdfLibraryEntry | string) => {
      const { cloudDocumentId, fingerprint } = resolvePdfDeleteTarget(
        target,
        currentEntry,
        libraryEntries,
      );

      if (cloudDocumentId) {
        await deleteCloudPdfDocument(cloudDocumentId);
      } else if (fingerprint) {
        await deletePdfLocalData(fingerprint);
      }

      if (readerSessionUserId) {
        clearReaderSessionDocument(readerSessionUserId, {
          cloudDocumentId,
          fingerprint,
        });
      }

      if (damagedLibraryFingerprint === fingerprint) {
        setDamagedLibraryFingerprint(undefined);
        setStatusMessage(undefined);
      }

      if (activeFingerprint === fingerprint || currentEntry?.cloudDocumentId === cloudDocumentId) {
        for (const card of pinnedTranslationCardsRef.current) {
          clearPinnedTranslationCardSaveTimer(card.key);
        }
        setCurrentEntry(undefined);
        setSentenceSelection(undefined);
        replacePinnedTranslationCards([]);
        setPins([]);
        setIsConfirmingClearPins(false);
      }

      await refreshLibrary();
    },
    [
      activeFingerprint,
      currentEntry,
      damagedLibraryFingerprint,
      clearPinnedTranslationCardSaveTimer,
      libraryEntries,
      readerSessionUserId,
      refreshLibrary,
      replacePinnedTranslationCards,
    ],
  );

  const handleClearCurrentPdfData = useCallback(async () => {
    if (!currentEntry) {
      return;
    }

    await handleDeletePdfData(currentEntry);
  }, [currentEntry, handleDeletePdfData]);

  const handleRemoveDamagedLibraryRecord = useCallback(() => {
    if (!damagedLibraryFingerprint) {
      return;
    }

    void handleDeletePdfData(damagedLibraryFingerprint).catch(() => {
      setStatusMessage("Could not remove the broken PDF history record.");
    });
  }, [damagedLibraryFingerprint, handleDeletePdfData]);

  const handleLocatePin = useCallback((pin: TranslationPin) => {
    locateRequestIdRef.current += 1;
    setLocateRequest({
      pin,
      requestId: locateRequestIdRef.current,
    });
    setMobilePanel(null);
  }, []);

  const handleRevealPinCard = useCallback((pin: TranslationPin) => {
    pinPanelFocusRequestIdRef.current += 1;
    setPinPanelFocusRequest({
      pinId: pin.id,
      requestId: pinPanelFocusRequestIdRef.current,
    });

    if (isNarrowViewport) {
      setMobilePanel("pins");
    } else {
      setIsPinsPaneOpen(true);
    }
  }, [isNarrowViewport]);

  const handleLibraryPaneToggle = useCallback(() => {
    if (isNarrowViewport) {
      setMobilePanel((panel) => (panel === "library" ? null : "library"));
      return;
    }

    setIsLibraryPaneOpen((isOpen) => !isOpen);
  }, [isNarrowViewport]);

  const handlePinsPaneToggle = useCallback(() => {
    if (isNarrowViewport) {
      setMobilePanel((panel) => (panel === "pins" ? null : "pins"));
      return;
    }

    setIsPinsPaneOpen((isOpen) => !isOpen);
  }, [isNarrowViewport]);

  const handlePaneResizeStart = useCallback(
    (pane: PaneResizeState["pane"], event: ReactPointerEvent<HTMLDivElement>) => {
      setIsPaneResizing(true);
      paneResizeStateRef.current = {
        pane,
        startWidth: pane === "library" ? libraryPaneWidth : pinsPaneWidth,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [libraryPaneWidth, pinsPaneWidth],
  );

  const handlePaneResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeState = paneResizeStateRef.current;

    if (!resizeState) {
      return;
    }

    if (resizeState.pane === "library") {
      setLibraryPaneWidth(
        clamp(
          resizeState.startWidth + event.clientX - resizeState.startX,
          LIBRARY_PANE_MIN_WIDTH,
          LIBRARY_PANE_MAX_WIDTH,
        ),
      );
    } else {
      setPinsPaneWidth(
        clamp(
          resizeState.startWidth + resizeState.startX - event.clientX,
          PINS_PANE_MIN_WIDTH,
          PINS_PANE_MAX_WIDTH,
        ),
      );
    }

    event.preventDefault();
  }, []);

  const handlePaneResizeEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (paneResizeStateRef.current) {
      paneResizeStateRef.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPaneResizing(false);
  }, []);

  const workspaceStyle = {
    "--library-pane-column": isLibraryPaneOpen ? `${libraryPaneWidth}px` : "0px",
    "--library-resizer-column": isLibraryPaneOpen ? "7px" : "0px",
    "--pins-pane-column": isPinsPaneOpen ? `${pinsPaneWidth}px` : "0px",
    "--pins-resizer-column": isPinsPaneOpen ? "7px" : "0px",
    "--library-pane-width": `${libraryPaneWidth}px`,
    "--pins-pane-width": `${pinsPaneWidth}px`,
  } as CSSProperties;
  const isLibraryControlOpen = isNarrowViewport ? mobilePanel === "library" : isLibraryPaneOpen;
  const isPinsControlOpen = isNarrowViewport ? mobilePanel === "pins" : isPinsPaneOpen;
  const compactMathpixStatusLabel = mathpixProcessView
    ? getCompactMathpixStatusLabel(mathpixProcessView, t)
    : undefined;
  const renderStatusMessage = () =>
    statusMessage ? (
      <div className="pane-status">
        <span>{statusMessage}</span>
        {damagedLibraryFingerprint ? (
          <button
            className="pane-status-action"
            onClick={handleRemoveDamagedLibraryRecord}
            type="button"
          >
            {t("common.remove")}
          </button>
        ) : null}
      </div>
    ) : null;
  const renderCompactMathpixStatus = () =>
    mathpixProcessView && compactMathpixStatusLabel ? (
      <span
        aria-label={t("mathpix.statusLabel")}
        aria-live="polite"
        className={`mathpix-compact-status mathpix-compact-status--${mathpixProcessView.tone}`}
        title={`${mathpixProcessView.title}. ${mathpixProcessView.detail}`}
      >
        {mathpixProcessView.tone === "success" ? (
          <Check aria-hidden="true" size={13} strokeWidth={2.4} />
        ) : mathpixProcessView.tone === "error" ? (
          <CircleAlert aria-hidden="true" size={13} strokeWidth={2.2} />
        ) : (
          <LoaderCircle aria-hidden="true" size={13} strokeWidth={2.2} />
        )}
        <span>{t("mathpix.label")}</span>
        <strong>{compactMathpixStatusLabel}</strong>
        <span
          aria-hidden="true"
          className="mathpix-compact-progress"
          style={{ width: `${mathpixProcessView.progressPercent}%` }}
        />
      </span>
    ) : null;
  const renderLibraryPaneContent = (closeButton: ReactNode) => (
    <>
      <div className="library-pane-header">
        <div className="pane-heading-row">
          <div className="pane-heading">{t("reader.library")}</div>
          {closeButton}
        </div>
        <PdfImportDropzone isImporting={isImporting} onImport={handleImport} variant="compact" />
      </div>
      {renderStatusMessage()}
      <PdfLibrary
        activeFingerprint={activeFingerprint}
        entries={libraryEntries}
        onDelete={handleDeletePdfData}
        onOpen={handleOpenHistory}
        showControls
      />
    </>
  );
  const renderPinsPaneContent = (closeButton: ReactNode) => (
    <>
      <div className="pane-heading-row">
        <div className="pane-heading">{t("reader.annotations")}</div>
        <div className="pins-clear-actions">
          {closeButton}
          {pins.length > 0 && isConfirmingClearPins ? (
            <>
              <button
                aria-label={t("common.confirm")}
                className="icon-button icon-button--small icon-button--success"
                onClick={handleClearPins}
                title={t("common.confirm")}
                type="button"
              >
                <Check aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              <button
                aria-label={t("common.cancel")}
                className="icon-button icon-button--small icon-button--danger"
                onClick={() => setIsConfirmingClearPins(false)}
                title={t("common.cancel")}
                type="button"
              >
                <X aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </>
          ) : null}
          {pins.length > 0 && !isConfirmingClearPins ? (
            <button
              aria-label={t("settings.clearCurrentPdfAnnotations")}
              className="icon-button icon-button--small"
              onClick={() => setIsConfirmingClearPins(true)}
              title={t("settings.clearCurrentPdfAnnotations")}
              type="button"
            >
              <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>
      <PinnedTranslationsPanel
        focusRequest={pinPanelFocusRequest}
        onAnnotationChange={handlePinAnnotation}
        onHighlightPin={handlePinHighlight}
        onLocatePin={handleLocatePin}
        onPinUpdated={handlePinUpdated}
        onUnpin={handleUnpin}
        paperContext={paperContext}
        pins={pins}
      />
    </>
  );
  const renderSidebarToggleButtons = () => (
    <>
      <button
        aria-label={isLibraryControlOpen ? t("reader.closeLibraryPane") : t("reader.openLibraryPane")}
        aria-pressed={isLibraryControlOpen}
        className="icon-button"
        onClick={handleLibraryPaneToggle}
        title={isLibraryControlOpen ? t("reader.closeLibrary") : t("reader.openLibrary")}
        type="button"
      >
        {isLibraryControlOpen ? (
          <PanelLeftClose aria-hidden="true" size={17} strokeWidth={2} />
        ) : (
          <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={2} />
        )}
      </button>
      <button
        aria-label={isPinsControlOpen ? t("reader.closeAnnotationsPane") : t("reader.openAnnotationsPane")}
        aria-pressed={isPinsControlOpen}
        className="icon-button"
        onClick={handlePinsPaneToggle}
        title={isPinsControlOpen ? t("reader.closeAnnotations") : t("reader.openAnnotations")}
        type="button"
      >
        {isPinsControlOpen ? (
          <PanelRightClose aria-hidden="true" size={17} strokeWidth={2} />
        ) : (
          <PanelRightOpen aria-hidden="true" size={17} strokeWidth={2} />
        )}
      </button>
    </>
  );
  const renderDocumentHeaderControls = () => (
    <div className="pdf-export-toolbar" aria-label={t("reader.exportControls")}>
      <button
        aria-label={t("reader.exportPdf")}
        className="icon-button"
        disabled={isExporting}
        onClick={handleExportPdf}
        title={t("reader.exportPdf")}
        type="button"
      >
        <Download aria-hidden="true" size={17} strokeWidth={2} />
      </button>
      <button
        aria-label={t("reader.exportPackage")}
        className="icon-button"
        disabled={isExporting}
        onClick={() => {
          void handleExportReadingPackage();
        }}
        title={t("reader.exportPackage")}
        type="button"
      >
        <Archive aria-hidden="true" size={17} strokeWidth={2} />
      </button>
    </div>
  );
  const renderMobileReaderSideDock = () => (
    <div className="mobile-reader-side-dock" aria-label={t("reader.sidePanels")}>
      <button
        aria-label={isLibraryControlOpen ? t("reader.closeLibraryPane") : t("reader.openLibraryPane")}
        aria-pressed={isLibraryControlOpen}
        className={`icon-button mobile-reader-side-dock-button mobile-reader-side-dock-button--library ${
          isLibraryControlOpen ? "mobile-reader-side-dock-button--active" : ""
        }`}
        onClick={handleLibraryPaneToggle}
        title={isLibraryControlOpen ? t("reader.closeLibrary") : t("reader.openLibrary")}
        type="button"
      >
        {isLibraryControlOpen ? (
          <PanelLeftClose aria-hidden="true" size={17} strokeWidth={2} />
        ) : (
          <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={2} />
        )}
      </button>
      <button
        aria-label={isPinsControlOpen ? t("reader.closeAnnotationsPane") : t("reader.openAnnotationsPane")}
        aria-pressed={isPinsControlOpen}
        className={`icon-button mobile-reader-side-dock-button mobile-reader-side-dock-button--pins ${
          isPinsControlOpen ? "mobile-reader-side-dock-button--active" : ""
        }`}
        onClick={handlePinsPaneToggle}
        title={isPinsControlOpen ? t("reader.closeAnnotations") : t("reader.openAnnotations")}
        type="button"
      >
        {isPinsControlOpen ? (
          <PanelRightClose aria-hidden="true" size={17} strokeWidth={2} />
        ) : (
          <PanelRightOpen aria-hidden="true" size={17} strokeWidth={2} />
        )}
      </button>
    </div>
  );
  const renderMobileModeControls = () => {
    const interactionModeLabel =
      mobileInteractionMode === "pan"
        ? t("reader.mobilePanMode")
        : t("reader.mobileSegmentedMode");

    return (
      <div
        className="reader-mode-control reader-mode-control--mobile"
        aria-label={t("reader.mobileInteractionMode")}
        role="group"
      >
        <button
          aria-label={interactionModeLabel}
          className={`mode-toggle-button mode-toggle-button--single ${
            mobileInteractionMode === "segmented"
              ? "mode-toggle-button--cross"
              : "mode-toggle-button--pan"
          }`}
          onClick={handleMobileInteractionModeToggle}
          title={interactionModeLabel}
          type="button"
        >
          {mobileInteractionMode === "segmented" ? (
            <Combine aria-hidden="true" size={16} strokeWidth={2} />
          ) : (
            <Hand aria-hidden="true" size={16} strokeWidth={2} />
          )}
        </button>
      </div>
    );
  };

  return (
    <I18nProvider locale={settings.uiLocale}>
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label={t("app.name")}>
          <span className="brand-mark">P</span>
          <span className="brand-text">{t("app.name")}</span>
        </div>
        <div className="topbar-actions">
          {currentEntry ? null : renderSidebarToggleButtons()}
          {renderCompactMathpixStatus()}
          <span className={`api-health api-health--${apiStatus}`} title={t("reader.apiStatusTitle", { status: apiStatus })}>
            {t("reader.api")}
          </span>
          <span
            aria-live="polite"
            className={`sync-health sync-health--${visibleCloudSyncStatus}`}
            title={visibleCloudSyncMessage}
          >
            {t(CLOUD_SYNC_STATUS_LABEL_KEYS[visibleCloudSyncStatus])}
          </span>
          <button
            aria-label={t("reader.openSettingsWithStatus", { status: mobileStatusLabel })}
            className="mobile-status-button"
            onClick={() => setIsSettingsOpen(true)}
            title={mobileStatusLabel}
            type="button"
          >
            <Activity aria-hidden="true" size={15} strokeWidth={2} />
            <span
              aria-hidden="true"
              className={`mobile-status-dot mobile-status-dot--api-${apiStatus}`}
            />
            <span
              aria-hidden="true"
              className={`mobile-status-dot mobile-status-dot--sync-${visibleCloudSyncStatus}`}
            />
          </button>
          <button
            className="account-button"
            onClick={() => {
              void auth.signOut().catch(() => {
                setStatusMessage("Could not sign out.");
              });
            }}
            title={t("reader.signOut")}
            type="button"
          >
            <span>{auth.user?.email ?? t("common.account")}</span>
            <LogOut aria-hidden="true" size={15} strokeWidth={2} />
          </button>
          <div className="reader-mode-control reader-mode-control--desktop" aria-label={t("reader.selectionMode")} role="group">
            <button
              aria-label={
                selectionMode === "continuous"
                  ? t("reader.continuousSelectionSwitch")
                  : t("reader.crossSelectionSwitch")
              }
              className={`mode-toggle-button mode-toggle-button--single ${
                selectionMode === "continuous" ? "mode-toggle-button--active" : "mode-toggle-button--cross"
              }`}
              onClick={() => handleSelectionModeChange(selectionMode === "continuous" ? "cross" : "continuous")}
              title={
                selectionMode === "continuous"
                  ? t("reader.dragSelectionMode")
                  : t("reader.crossSelectionMode")
              }
              type="button"
            >
              {selectionMode === "continuous" ? (
                <MousePointer2 aria-hidden="true" size={16} strokeWidth={2} />
              ) : (
                <Combine aria-hidden="true" size={16} strokeWidth={2} />
              )}
            </button>
          </div>
          {renderMobileModeControls()}
          <SettingsButton isOpen={isSettingsOpen} onClick={() => setIsSettingsOpen(true)} />
        </div>
      </header>

      {isSettingsOpen ? (
        <SettingsPanel
          apiKeyConfigured={health.status === "ok" ? health.data.deepseek.apiKeyConfigured : undefined}
          apiStatus={apiStatus}
          currentEntry={currentEntry}
          libraryEntries={libraryEntries}
          onClearCurrentPdfData={handleClearCurrentPdfData}
          onClearCurrentPdfPins={handleClearCurrentPdfPins}
          onClearTranslationCache={handleClearTranslationCache}
          onClose={() => setIsSettingsOpen(false)}
          onDeletePdfData={handleDeletePdfData}
          onPaperContextSave={handlePaperContextSave}
          onSettingsChange={handleSettingsChange}
          paperContext={paperContext}
          settings={settings}
          supabaseConfigured={health.status === "ok" ? health.data.supabase.configured : undefined}
        />
      ) : null}

      <main className={`reader-workspace ${isPaneResizing ? "reader-workspace--resizing" : ""}`} style={workspaceStyle}>
        <aside
          className={`library-pane ${isLibraryPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isLibraryPaneOpen}
          aria-label={t("reader.pdfLibrary")}
        >
          {renderLibraryPaneContent(
            <button
              aria-label={t("reader.closeLibraryPane")}
              className="icon-button icon-button--small"
              onClick={() => setIsLibraryPaneOpen(false)}
              title={t("reader.closeLibrary")}
              type="button"
            >
              <PanelLeftClose aria-hidden="true" size={16} strokeWidth={2} />
            </button>,
          )}
        </aside>
        <div
          aria-label={t("reader.resizeLibraryPane")}
          aria-orientation="vertical"
          className={`pane-resizer pane-resizer--library ${isLibraryPaneOpen ? "" : "pane-resizer--closed"}`}
          aria-hidden={!isLibraryPaneOpen}
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("library", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title={t("reader.resizeLibraryPane")}
        >
          <button
            aria-label={isLibraryPaneOpen ? t("reader.closeLibraryPane") : t("reader.openLibraryPane")}
            className="pane-resizer-toggle"
            onClick={handleLibraryPaneToggle}
            title={isLibraryPaneOpen ? t("reader.closeLibrary") : t("reader.openLibrary")}
            type="button"
          >
            {isLibraryPaneOpen ? (
              <PanelLeftClose aria-hidden="true" size={14} strokeWidth={2.5} />
            ) : (
              <PanelLeftOpen aria-hidden="true" size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
        <section
          className={`document-stage ${currentEntry ? "document-stage--active" : ""}`}
          aria-label={t("reader.pdfReader")}
        >
          {currentEntry ? (
            <PdfViewer
              activeTranslationCardZIndex={activeTranslationCardZIndex}
              activeSelection={sentenceSelection}
              entry={currentEntry}
              headerControls={renderDocumentHeaderControls()}
              locateRequest={locateRequest}
              onActivateTranslationCard={handleActivateTranslationCard}
              onCreateAnnotation={handleCreateAnnotation}
              onCloseTranslationCard={handleCloseTranslationCard}
              onPinTranslationCard={handlePinTranslationCard}
              onPinnedTranslationRefresh={handlePinnedTranslationRefresh}
              onPinTranslation={handlePinTranslation}
              onRevealPinCard={handleRevealPinCard}
              onDocumentLoadError={handleDocumentLoadError}
              onRemoveLocalRecord={handleDeletePdfData}
              onPageTextReadyForPaperContext={handlePageTextReadyForPaperContext}
              onReadingPositionChange={handleReadingPositionChange}
              onSentenceSelectionChange={handleSentenceSelectionChange}
              onTranslationCardViewChange={handleTranslationCardViewChange}
              pinnedTranslationCards={pinnedTranslationCards}
              paperContext={paperContext}
              pins={pins}
              mobileInteractionMode={mobileInteractionMode}
              selectionMode={selectionMode}
              settings={settings}
            />
          ) : (
            <div className="empty-reader">
              <PdfImportDropzone isImporting={isImporting} onImport={handleImport} />
              {renderStatusMessage()}
              <div className="empty-page-frame" aria-label={t("reader.noDocumentOpen")}>
                <div className="empty-page-line empty-page-line--wide" />
                <div className="empty-page-line" />
                <div className="empty-page-line empty-page-line--short" />
              </div>
              {libraryEntries.length > 0 ? (
                <div className="empty-reader-history">
                  <div className="pane-heading">{t("reader.recent")}</div>
                  <PdfLibrary
                    activeFingerprint={activeFingerprint}
                    entries={libraryEntries}
                    onDelete={handleDeletePdfData}
                    onOpen={handleOpenHistory}
                  />
                </div>
              ) : null}
            </div>
          )}
        </section>
        <div
          aria-label={t("reader.resizeAnnotationsPane")}
          aria-orientation="vertical"
          className={`pane-resizer pane-resizer--pins ${isPinsPaneOpen ? "" : "pane-resizer--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("pins", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title={t("reader.resizeAnnotationsPane")}
        >
          <button
            aria-label={isPinsPaneOpen ? t("reader.closeAnnotationsPane") : t("reader.openAnnotationsPane")}
            className="pane-resizer-toggle"
            onClick={handlePinsPaneToggle}
            title={isPinsPaneOpen ? t("reader.closeAnnotations") : t("reader.openAnnotations")}
            type="button"
          >
            {isPinsPaneOpen ? (
              <PanelRightClose aria-hidden="true" size={14} strokeWidth={2.5} />
            ) : (
              <PanelRightOpen aria-hidden="true" size={14} strokeWidth={2.5} />
            )}
          </button>
        </div>
        <aside
          className={`translation-pane ${isPinsPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          aria-label={t("reader.annotations")}
        >
          {renderPinsPaneContent(
            <button
              aria-label={t("reader.closeAnnotationsPane")}
              className="icon-button icon-button--small"
              onClick={() => setIsPinsPaneOpen(false)}
              title={t("reader.closeAnnotations")}
              type="button"
            >
              <PanelRightClose aria-hidden="true" size={16} strokeWidth={2} />
            </button>,
          )}
        </aside>
      </main>
      {!isNarrowViewport && !isLibraryPaneOpen && (
        <button
          aria-label={t("reader.openLibraryPane")}
          className="pane-reopen-tab pane-reopen-tab--library"
          onClick={handleLibraryPaneToggle}
          title={t("reader.openLibrary")}
          type="button"
        >
          <PanelLeftOpen aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      )}
      {!isNarrowViewport && !isPinsPaneOpen && (
        <button
          aria-label={t("reader.openAnnotationsPane")}
          className="pane-reopen-tab pane-reopen-tab--pins"
          onClick={handlePinsPaneToggle}
          title={t("reader.openAnnotations")}
          type="button"
        >
          <PanelRightOpen aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      )}
      {currentEntry ? renderMobileReaderSideDock() : null}
      {mobilePanel ? (
        <div
          className="mobile-panel-backdrop"
          onClick={() => setMobilePanel(null)}
          role="presentation"
        >
          <aside
            aria-label={mobilePanel === "library" ? t("reader.pdfLibrary") : t("reader.annotations")}
            className={`mobile-panel mobile-panel--${mobilePanel}`}
            onClick={(event) => event.stopPropagation()}
          >
            {mobilePanel === "library"
              ? renderLibraryPaneContent(
                  <button
                    aria-label={t("reader.closeLibraryPane")}
                    className="icon-button icon-button--small"
                    onClick={() => setMobilePanel(null)}
                    title={t("reader.closeLibrary")}
                    type="button"
                  >
                    <PanelLeftClose aria-hidden="true" size={16} strokeWidth={2} />
                  </button>,
                )
              : renderPinsPaneContent(
                  <button
                    aria-label={t("reader.closeAnnotationsPane")}
                    className="icon-button icon-button--small"
                    onClick={() => setMobilePanel(null)}
                    title={t("reader.closeAnnotations")}
                    type="button"
                  >
                    <PanelRightClose aria-hidden="true" size={16} strokeWidth={2} />
                  </button>,
                )}
          </aside>
        </div>
      ) : null}
    </div>
    </I18nProvider>
  );
}

function upsertPin(pins: TranslationPin[], pin: TranslationPin) {
  const nextPins = [
    ...pins.filter((currentPin) => !isSamePinTarget(currentPin, pin)),
    pin,
  ];

  return sortPins(nextPins);
}

function mergePins(leftPins: TranslationPin[], rightPins: TranslationPin[]) {
  const pinsByTarget = new Map<string, TranslationPin>();

  for (const pin of [...leftPins, ...rightPins]) {
    const targetKey = createPinTargetKey(pin);
    const currentPin = pinsByTarget.get(targetKey);

    if (!currentPin || pin.updatedAt >= currentPin.updatedAt) {
      pinsByTarget.set(targetKey, pin);
    }
  }

  return sortPins(Array.from(pinsByTarget.values()));
}

function sortPins(pins: TranslationPin[]) {
  return pins.slice().sort((left, right) => {
    if (left.pageIndex !== right.pageIndex) {
      return left.pageIndex - right.pageIndex;
    }

    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

function createPinTargetKey(input: {
  normalizedSentence: string;
  pageIndex: number;
  pdfFingerprint: string;
}) {
  return JSON.stringify({
    normalizedSentence: input.normalizedSentence,
    pageIndex: input.pageIndex,
    pdfFingerprint: input.pdfFingerprint,
  });
}

function isSamePinTarget(
  left: {
    normalizedSentence: string;
    pageIndex: number;
    pdfFingerprint: string;
  },
  right: {
    normalizedSentence: string;
    pageIndex: number;
    pdfFingerprint: string;
  },
) {
  return createPinTargetKey(left) === createPinTargetKey(right);
}

function resolvePdfDeleteTarget(
  target: CloudPdfLibraryEntry | PdfLibraryEntry | string | undefined,
  currentEntry: PdfLibraryEntry | undefined,
  libraryEntries: CloudPdfLibraryEntry[],
) {
  if (!target) {
    return {};
  }

  if (typeof target !== "string") {
    return {
      cloudDocumentId: target.cloudDocumentId,
      fingerprint: target.fingerprint,
    };
  }

  const libraryEntry = libraryEntries.find((entry) =>
    entry.cloudDocumentId === target || entry.fingerprint === target
  );

  if (libraryEntry) {
    return {
      cloudDocumentId: libraryEntry.cloudDocumentId,
      fingerprint: libraryEntry.fingerprint,
    };
  }

  if (currentEntry?.cloudDocumentId === target || currentEntry?.fingerprint === target) {
    return {
      cloudDocumentId: currentEntry.cloudDocumentId,
      fingerprint: currentEntry.fingerprint,
    };
  }

  return {
    fingerprint: target,
  };
}

async function applyArchiveReadingPosition(
  entry: PdfLibraryEntry,
  document: DocumentArchiveDocument,
) {
  const position = getArchiveReadingPosition(document);

  if (!position || hasReadingPosition(entry)) {
    return entry;
  }

  if (entry.cloudDocumentId) {
    const updatedEntry = await updateCloudReadingPosition(entry.cloudDocumentId, position);

    return {
      ...entry,
      lastOpenedAt: updatedEntry.lastOpenedAt,
      lastPageIndex: updatedEntry.lastPageIndex,
      lastScrollTop: updatedEntry.lastScrollTop,
      lastZoom: updatedEntry.lastZoom,
    };
  }

  return await updatePdfReadingPosition(entry.fingerprint, position) ?? entry;
}

function getArchiveReadingPosition(
  document: DocumentArchiveDocument,
): ReadingPositionUpdate | undefined {
  const position: ReadingPositionUpdate = {};

  if (typeof document.lastPageIndex === "number") {
    position.lastPageIndex = document.lastPageIndex;
  }

  if (typeof document.lastScrollTop === "number") {
    position.lastScrollTop = document.lastScrollTop;
  }

  if (typeof document.lastZoom === "number") {
    position.lastZoom = document.lastZoom;
  }

  return hasReadingPosition(position) ? position : undefined;
}

function hasReadingPosition(position: ReadingPositionUpdate) {
  return (
    typeof position.lastPageIndex === "number" ||
    typeof position.lastScrollTop === "number" ||
    typeof position.lastZoom === "number"
  );
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function isMathpixRecordCurrentForEntry(
  record: MathpixDocumentRecord,
  entry: PdfLibraryEntry,
) {
  return (
    record.mathpixOptionsHash === MATHPIX_OPTIONS_HASH &&
    (!entry.contentSha256 || !record.contentSha256 || entry.contentSha256 === record.contentSha256)
  );
}

function getLatestLibraryEntry(entries: CloudPdfLibraryEntry[]) {
  return entries.reduce<CloudPdfLibraryEntry | undefined>((latestEntry, entry) => {
    if (!latestEntry || entry.lastOpenedAt > latestEntry.lastOpenedAt) {
      return entry;
    }

    return latestEntry;
  }, undefined);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
