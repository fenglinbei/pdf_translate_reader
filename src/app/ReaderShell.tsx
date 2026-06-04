import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  Activity,
  Check,
  Combine,
  Languages,
  LogOut,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  TextSelect,
  Trash2,
  X,
} from "lucide-react";
import { deletePdfLocalData, type ReadingPositionUpdate } from "../cache/pdfLibraryRepository";
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
  PaperContextRecord,
  PdfLibraryEntry,
  ReaderMode,
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

const LIBRARY_PANE_DEFAULT_WIDTH = 240;
const LIBRARY_PANE_MAX_WIDTH = 380;
const LIBRARY_PANE_MIN_WIDTH = 180;
const PINS_PANE_DEFAULT_WIDTH = 280;
const PINS_PANE_MAX_WIDTH = 460;
const PINS_PANE_MIN_WIDTH = 300;
const TRANSLATION_CARD_BASE_Z_INDEX = 20;

const CLOUD_SYNC_STATUS_LABELS: Record<VisibleCloudSyncStatus, string> = {
  "cloud-missing": "Setup",
  "local-only": "Local only",
  checking: "Checking",
  offline: "Offline",
  synced: "Synced",
  syncing: "Syncing",
};

function getVisibleCloudSyncMessage(
  status: VisibleCloudSyncStatus,
  latestSyncMessage: string,
) {
  switch (status) {
    case "checking":
      return "Checking cloud sync status.";
    case "cloud-missing":
      return "Supabase is not configured on the API.";
    case "offline":
      return "Cloud sync is unavailable while the API is offline.";
    case "synced":
      return latestSyncMessage || "Cloud sync is ready.";
    case "syncing":
      return latestSyncMessage || "Syncing changes to cloud.";
    case "local-only":
      return latestSyncMessage || "Saved locally, but cloud sync failed.";
    default:
      return "Cloud sync is ready.";
  }
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
  const [paperContext, setPaperContext] = useState<PaperContextRecord>();
  const [pins, setPins] = useState<TranslationPin[]>([]);
  const [pinnedTranslationCards, setPinnedTranslationCards] = useState<PinnedTranslationCard[]>([]);
  const [readerMode, setReaderMode] = useState<ReaderMode>("translate");
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("continuous");
  const [sentenceSelection, setSentenceSelection] = useState<SentenceSelection>();
  const [activeTranslationCardZIndex, setActiveTranslationCardZIndex] = useState(
    TRANSLATION_CARD_BASE_Z_INDEX,
  );
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [statusMessage, setStatusMessage] = useState<string>();
  const [cloudSyncMessage, setCloudSyncMessage] = useState("Cloud sync is ready.");
  const [cloudSyncStatus, setCloudSyncStatus] = useState<CloudSyncStatus>("idle");
  const [damagedLibraryFingerprint, setDamagedLibraryFingerprint] = useState<string>();
  const [readerSessionHydratedUserId, setReaderSessionHydratedUserId] = useState<string>();
  const activeReaderSessionUserIdRef = useRef<string>();
  const autoRestoreUserIdRef = useRef<string>();
  const locateRequestIdRef = useRef(0);
  const paneResizeStateRef = useRef<PaneResizeState>();
  const pinPanelFocusRequestIdRef = useRef(0);
  const pinsRef = useRef<TranslationPin[]>([]);
  const pinnedTranslationCardSaveTimersRef = useRef(new Map<string, number>());
  const pinnedTranslationCardsRef = useRef<PinnedTranslationCard[]>([]);
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
  );
  const mobileStatusLabel = `API ${apiStatus}. ${visibleCloudSyncMessage}`;

  const applyPinnedTranslationCards = useCallback((nextCards: PinnedTranslationCard[]) => {
    pinnedTranslationCardsRef.current = nextCards;
    setPinnedTranslationCards(nextCards);
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
      applyPinnedTranslationCards([]);
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
    setReaderMode(savedSession?.readerMode ?? "translate");
    setSelectionMode(savedSession?.selectionMode ?? "continuous");
    setReaderSessionHydratedUserId(readerSessionUserId);
  }, [applyPinnedTranslationCards, readerSessionUserId]);

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
      pinsPaneWidth,
      readerMode,
      selectionMode,
    });
  }, [
    isLibraryPaneOpen,
    isPinsPaneOpen,
    libraryPaneWidth,
    pinsPaneWidth,
    readerMode,
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
      setPaperContext(undefined);
      setPins([]);
      applyPinnedTranslationCards([]);
      setIsConfirmingClearPins(false);
      return undefined;
    }

    paperContextPageTextsRef.current = new Map();
    applyPinnedTranslationCards([]);
    setIsConfirmingClearPins(false);
    let cancelled = false;

    if (currentEntry) {
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
          const nextZIndex = Math.max(
            TRANSLATION_CARD_BASE_Z_INDEX,
            ...loadedCards.map((card) => card.zIndex),
          );

          translationCardZIndexRef.current = nextZIndex;
          setActiveTranslationCardZIndex(nextZIndex);
          applyPinnedTranslationCards(loadedCards);
        }
      })
      .catch(() => {
        if (!cancelled) {
          applyPinnedTranslationCards([]);
          setStatusMessage("Could not read pinned translation cards for this PDF.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeFingerprint, applyPinnedTranslationCards]);

  const handleImport = useCallback(
    async (file: File) => {
      setIsImporting(true);
      setStatusMessage(undefined);
      setDamagedLibraryFingerprint(undefined);

      try {
        const identity = await createPdfFingerprint(file);
        const entry = await importPdfToCloud(file, identity);
        if (entry.cloudDocumentId) {
          await hydrateCloudDocumentState(entry.cloudDocumentId, entry.fingerprint).catch(() => {
            setStatusMessage("Could not sync cloud document state.");
          });
        }

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
        setMobilePanel(null);
        applyPinnedTranslationCards([]);
        setPins([]);
        await refreshLibrary();
      } catch (error) {
        setStatusMessage(getStorageErrorMessage(error, "Could not import this PDF."));
      } finally {
        setIsImporting(false);
      }
    },
    [applyPinnedTranslationCards, refreshLibrary],
  );

  const handleOpenHistory = useCallback(
    async (entry: CloudPdfLibraryEntry) => {
      setStatusMessage(undefined);
      setDamagedLibraryFingerprint(undefined);

      try {
        const openedEntry = await openCloudPdfDocument(entry.cloudDocumentId);
        if (openedEntry.cloudDocumentId) {
          await hydrateCloudDocumentState(openedEntry.cloudDocumentId, openedEntry.fingerprint).catch(() => {
            setStatusMessage("Could not sync cloud document state.");
          });
        }

        setCurrentEntry(openedEntry);
        setSentenceSelection(undefined);
        setMobilePanel(null);
        applyPinnedTranslationCards([]);
        setPins([]);
        await refreshLibrary();
      } catch (error) {
        setDamagedLibraryFingerprint(entry.fingerprint);
        setStatusMessage(
          error instanceof Error
            ? `${error.message} Try opening it again or remove the cloud PDF record.`
            : "Could not open this PDF. Try opening it again or remove the cloud PDF record.",
        );
      }
    },
    [applyPinnedTranslationCards, refreshLibrary],
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

    const nextZIndex =
      Math.max(
        translationCardZIndexRef.current,
        ...currentCards.map((card) => card.zIndex),
      ) + 1;
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
    const nextZIndex = translationCardZIndexRef.current + 1;
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
    }
  }, [clearPinnedTranslationCardSaveTimer, updatePinnedTranslationCards]);

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
    setSentenceSelection(selection);

    if (!selection) {
      return;
    }

    const nextZIndex = translationCardZIndexRef.current + 1;

    translationCardZIndexRef.current = nextZIndex;
    setActiveTranslationCardZIndex(nextZIndex);
  }, []);

  const handleReaderModeChange = useCallback((nextMode: ReaderMode) => {
    setReaderMode(nextMode);
    setSentenceSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, []);

  const handleSelectionModeChange = useCallback((nextMode: SelectionMode) => {
    setSelectionMode(nextMode);
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
        applyPinnedTranslationCards([]);
        setPins([]);
        setIsConfirmingClearPins(false);
      }

      await refreshLibrary();
    },
    [
      activeFingerprint,
      currentEntry,
      damagedLibraryFingerprint,
      applyPinnedTranslationCards,
      clearPinnedTranslationCardSaveTimer,
      libraryEntries,
      readerSessionUserId,
      refreshLibrary,
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
            Remove
          </button>
        ) : null}
      </div>
    ) : null;
  const renderLibraryPaneContent = (closeButton: ReactNode) => (
    <>
      <div className="library-pane-header">
        <div className="pane-heading-row">
          <div className="pane-heading">Library</div>
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
        <div className="pane-heading">Annotations</div>
        <div className="pins-clear-actions">
          {closeButton}
          {pins.length > 0 && isConfirmingClearPins ? (
            <>
              <button
                aria-label="Confirm clear all annotations"
                className="icon-button icon-button--small icon-button--success"
                onClick={handleClearPins}
                title="Confirm clear all annotations"
                type="button"
              >
                <Check aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              <button
                aria-label="Cancel clear all annotations"
                className="icon-button icon-button--small icon-button--danger"
                onClick={() => setIsConfirmingClearPins(false)}
                title="Cancel"
                type="button"
              >
                <X aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </>
          ) : null}
          {pins.length > 0 && !isConfirmingClearPins ? (
            <button
              aria-label="Clear all annotations"
              className="icon-button icon-button--small"
              onClick={() => setIsConfirmingClearPins(true)}
              title="Clear all annotations"
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
        aria-label={isLibraryControlOpen ? "Close library pane" : "Open library pane"}
        aria-pressed={isLibraryControlOpen}
        className="icon-button"
        onClick={handleLibraryPaneToggle}
        title={isLibraryControlOpen ? "Close library" : "Open library"}
        type="button"
      >
        {isLibraryControlOpen ? (
          <PanelLeftClose aria-hidden="true" size={17} strokeWidth={2} />
        ) : (
          <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={2} />
        )}
      </button>
      <button
        aria-label={isPinsControlOpen ? "Close annotations pane" : "Open annotations pane"}
        aria-pressed={isPinsControlOpen}
        className="icon-button"
        onClick={handlePinsPaneToggle}
        title={isPinsControlOpen ? "Close annotations" : "Open annotations"}
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label="PDF Translate Reader">
          <span className="brand-mark">P</span>
          <span className="brand-text">PDF Translate Reader</span>
        </div>
        <div className="topbar-actions">
          {currentEntry ? null : renderSidebarToggleButtons()}
          <span className={`api-health api-health--${apiStatus}`} title={`API ${apiStatus}`}>
            API
          </span>
          <span
            aria-live="polite"
            className={`sync-health sync-health--${visibleCloudSyncStatus}`}
            title={visibleCloudSyncMessage}
          >
            {CLOUD_SYNC_STATUS_LABELS[visibleCloudSyncStatus]}
          </span>
          <button
            aria-label={`Open settings. ${mobileStatusLabel}`}
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
            title="Sign out"
            type="button"
          >
            <span>{auth.user?.email ?? "Account"}</span>
            <LogOut aria-hidden="true" size={15} strokeWidth={2} />
          </button>
          <div className="reader-mode-control" aria-label="Reader mode" role="group">
            <button
              aria-label={
                readerMode === "translate"
                  ? "Translation mode. Switch to text selection copy mode"
                  : "Text selection copy mode. Switch to translation mode"
              }
              className={`mode-toggle-button mode-toggle-button--single ${
                readerMode === "translate" ? "mode-toggle-button--active" : "mode-toggle-button--select"
              }`}
              onClick={() => handleReaderModeChange(readerMode === "translate" ? "select" : "translate")}
              title={
                readerMode === "translate"
                  ? "Translation mode. Tap to switch to Select"
                  : "Select mode. Tap to switch to Translate"
              }
              type="button"
            >
              {readerMode === "translate" ? (
                <Languages aria-hidden="true" size={16} strokeWidth={2} />
              ) : (
                <TextSelect aria-hidden="true" size={16} strokeWidth={2} />
              )}
            </button>
          </div>
          <div className="reader-mode-control" aria-label="Selection mode" role="group">
            <button
              aria-label={
                selectionMode === "continuous"
                  ? "Continuous drag selection. Switch to cross-region selection"
                  : "Cross-region selection. Switch to continuous drag selection"
              }
              className={`mode-toggle-button mode-toggle-button--single ${
                selectionMode === "continuous" ? "mode-toggle-button--active" : "mode-toggle-button--cross"
              }`}
              onClick={() => handleSelectionModeChange(selectionMode === "continuous" ? "cross" : "continuous")}
              title={
                selectionMode === "continuous"
                  ? "Drag selection. Tap to switch to Cross"
                  : "Cross selection. Tap to switch to Drag"
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

      <main className="reader-workspace" style={workspaceStyle}>
        <aside
          className={`library-pane ${isLibraryPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isLibraryPaneOpen}
          aria-label="PDF library"
        >
          {renderLibraryPaneContent(
            <button
              aria-label="Close library pane"
              className="icon-button icon-button--small"
              onClick={() => setIsLibraryPaneOpen(false)}
              title="Close library"
              type="button"
            >
              <PanelLeftClose aria-hidden="true" size={16} strokeWidth={2} />
            </button>,
          )}
        </aside>
        <div
          aria-label="Resize library pane"
          aria-orientation="vertical"
          className={`pane-resizer pane-resizer--library ${isLibraryPaneOpen ? "" : "pane-resizer--closed"}`}
          aria-hidden={!isLibraryPaneOpen}
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("library", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title="Resize library pane"
        />
        <section
          className={`document-stage ${currentEntry ? "document-stage--active" : ""}`}
          aria-label="PDF reader"
        >
          {currentEntry ? (
            <PdfViewer
              activeTranslationCardZIndex={activeTranslationCardZIndex}
              activeSelection={sentenceSelection}
              entry={currentEntry}
              headerControls={
                <div className="pdf-sidebar-toolbar" aria-label="Reader side panels">
                  {renderSidebarToggleButtons()}
                </div>
              }
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
              readerMode={readerMode}
              selectionMode={selectionMode}
              settings={settings}
            />
          ) : (
            <div className="empty-reader">
              <PdfImportDropzone isImporting={isImporting} onImport={handleImport} />
              {renderStatusMessage()}
              <div className="empty-page-frame" aria-label="No document open">
                <div className="empty-page-line empty-page-line--wide" />
                <div className="empty-page-line" />
                <div className="empty-page-line empty-page-line--short" />
              </div>
              {libraryEntries.length > 0 ? (
                <div className="empty-reader-history">
                  <div className="pane-heading">Recent</div>
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
          aria-label="Resize annotations pane"
          aria-orientation="vertical"
          className={`pane-resizer pane-resizer--pins ${isPinsPaneOpen ? "" : "pane-resizer--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("pins", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title="Resize annotations pane"
        />
        <aside
          className={`translation-pane ${isPinsPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          aria-label="Annotations"
        >
          {renderPinsPaneContent(
            <button
              aria-label="Close annotations pane"
              className="icon-button icon-button--small"
              onClick={() => setIsPinsPaneOpen(false)}
              title="Close annotations"
              type="button"
            >
              <PanelRightClose aria-hidden="true" size={16} strokeWidth={2} />
            </button>,
          )}
        </aside>
      </main>
      {mobilePanel ? (
        <div
          className="mobile-panel-backdrop"
          onClick={() => setMobilePanel(null)}
          role="presentation"
        >
          <aside
            aria-label={mobilePanel === "library" ? "PDF library" : "Annotations"}
            className={`mobile-panel mobile-panel--${mobilePanel}`}
            onClick={(event) => event.stopPropagation()}
          >
            {mobilePanel === "library"
              ? renderLibraryPaneContent(
                  <button
                    aria-label="Close library pane"
                    className="icon-button icon-button--small"
                    onClick={() => setMobilePanel(null)}
                    title="Close library"
                    type="button"
                  >
                    <PanelLeftClose aria-hidden="true" size={16} strokeWidth={2} />
                  </button>,
                )
              : renderPinsPaneContent(
                  <button
                    aria-label="Close annotations pane"
                    className="icon-button icon-button--small"
                    onClick={() => setMobilePanel(null)}
                    title="Close annotations"
                    type="button"
                  >
                    <PanelRightClose aria-hidden="true" size={16} strokeWidth={2} />
                  </button>,
                )}
          </aside>
        </div>
      ) : null}
    </div>
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
