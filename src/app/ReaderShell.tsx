import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import {
  Check,
  Combine,
  Languages,
  MousePointer2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  TextSelect,
  Trash2,
  X,
} from "lucide-react";
import {
  deletePdfLocalData,
  listPdfLibraryEntries,
  markPdfOpened,
  saveImportedPdf,
  updatePdfReadingPosition,
  type ReadingPositionUpdate,
} from "../cache/pdfLibraryRepository";
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
  updatePinHighlight,
  updatePinTranslation,
  type PinWriteInput,
} from "../pins/pinRepository";
import { PinnedTranslationsPanel } from "../pins/PinnedTranslationsPanel";
import { SettingsButton } from "../settings/SettingsButton";
import { SettingsPanel } from "../settings/SettingsPanel";
import {
  DEFAULT_APP_SETTINGS,
  getAppSettings,
  putAppSettings,
} from "../settings/settingsRepository";
import type {
  AppSettings,
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
import { useApiHealth } from "./useApiHealth";

type PaneResizeState = {
  pane: "library" | "pins";
  startWidth: number;
  startX: number;
};

const LIBRARY_PANE_DEFAULT_WIDTH = 240;
const LIBRARY_PANE_MAX_WIDTH = 380;
const LIBRARY_PANE_MIN_WIDTH = 180;
const PINS_PANE_DEFAULT_WIDTH = 280;
const PINS_PANE_MAX_WIDTH = 460;
const PINS_PANE_MIN_WIDTH = 300;
const TRANSLATION_CARD_BASE_Z_INDEX = 20;

export function ReaderShell() {
  const health = useApiHealth();
  const apiStatus = health.status === "ok" ? "online" : health.status;
  const [libraryEntries, setLibraryEntries] = useState<PdfLibraryEntry[]>([]);
  const [currentEntry, setCurrentEntry] = useState<PdfLibraryEntry>();
  const [isImporting, setIsImporting] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLibraryPaneOpen, setIsLibraryPaneOpen] = useState(true);
  const [isPinsPaneOpen, setIsPinsPaneOpen] = useState(true);
  const [libraryPaneWidth, setLibraryPaneWidth] = useState(LIBRARY_PANE_DEFAULT_WIDTH);
  const [isConfirmingClearPins, setIsConfirmingClearPins] = useState(false);
  const [locateRequest, setLocateRequest] = useState<PinLocateRequest>();
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
  const locateRequestIdRef = useRef(0);
  const paneResizeStateRef = useRef<PaneResizeState>();
  const pinsRef = useRef<TranslationPin[]>([]);
  const pinnedTranslationCardSaveTimersRef = useRef(new Map<string, number>());
  const pinnedTranslationCardsRef = useRef<PinnedTranslationCard[]>([]);
  const translationCardZIndexRef = useRef(TRANSLATION_CARD_BASE_Z_INDEX);
  const activeFingerprint = currentEntry?.fingerprint;
  const currentFileName = currentEntry?.fileName;
  const currentMetadataTitle = currentEntry?.pdfMetadata?.title;
  const paperContextPageTextsRef = useRef(new Map<number, string>());

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
    setLibraryEntries(await listPdfLibraryEntries());
  }, []);

  useEffect(() => {
    void refreshLibrary().catch(() => {
      setStatusMessage("Could not read the local PDF library.");
    });
  }, [refreshLibrary]);

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
          setStatusMessage("Could not read saved favorites for this PDF.");
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

      try {
        const identity = await createPdfFingerprint(file);
        const blob = file.slice(0, file.size, "application/pdf");
        let entry: PdfLibraryEntry;

        try {
          entry = await saveImportedPdf({
            ...identity,
            blob,
          });
        } catch (error) {
          const now = Date.now();

          entry = {
            ...identity,
            blob,
            importedAt: now,
            lastOpenedAt: now,
            mimeType: "application/pdf",
            openCount: 1,
          };
          setStatusMessage(
            getStorageErrorMessage(error, "Could not cache this PDF locally. Reading it temporarily."),
          );
        }

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
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
    async (fingerprint: string) => {
      setStatusMessage(undefined);

      try {
        const entry = await markPdfOpened(fingerprint);

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
        applyPinnedTranslationCards([]);
        setPins([]);
        await refreshLibrary();
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Could not open this PDF.");
      }
    },
    [applyPinnedTranslationCards, refreshLibrary],
  );

  const handleReadingPositionChange = useCallback(
    (position: ReadingPositionUpdate) => {
      if (!activeFingerprint) {
        return;
      }

      void updatePdfReadingPosition(activeFingerprint, position).then((updatedEntry) => {
        if (!updatedEntry) {
          return;
        }

        setCurrentEntry((entry) =>
          entry?.fingerprint === updatedEntry.fingerprint
            ? { ...updatedEntry, blob: entry.blob }
            : entry,
        );
        setLibraryEntries((entries) =>
          entries.map((entry) =>
            entry.fingerprint === updatedEntry.fingerprint
              ? { ...updatedEntry, blob: entry.blob }
              : entry,
          ),
        );
      });
    },
    [activeFingerprint],
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
    void deletePinnedTranslationCard(targetKey).catch(() => {
      setStatusMessage("Could not remove pinned translation card.");
    });
  }, [clearPinnedTranslationCardSaveTimer, updatePinnedTranslationCards]);

  const handlePinTranslationCard = useCallback((input: TranslationCardPinInput) => {
    const targetKey = createPinTargetKey(input.selection);
    const currentCards = pinnedTranslationCardsRef.current;

    if (currentCards.some((currentCard) => currentCard.key === targetKey)) {
      clearPinnedTranslationCardSaveTimer(targetKey);
      updatePinnedTranslationCards((cards) =>
        cards.filter((currentCard) => currentCard.key !== targetKey),
      );
      void deletePinnedTranslationCard(targetKey).catch(() => {
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
      key: targetKey,
      zIndex: nextZIndex,
    };

    translationCardZIndexRef.current = nextZIndex;
    updatePinnedTranslationCards((cards) => [...cards, nextCard]);
    persistPinnedTranslationCard(nextCard);
  }, [
    clearPinnedTranslationCardSaveTimer,
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
      persistPinnedTranslationCard(updatedCard);
    }
  }, [persistPinnedTranslationCard, updatePinnedTranslationCards]);

  const handleTranslationCardViewChange = useCallback(
    (selection: SentenceSelection, viewChange: TranslationCardViewChange) => {
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

      if (updatedCard) {
        persistPinnedTranslationCard(updatedCard, { debounce: true });
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
        setStatusMessage("Could not remove this favorite.");
        throw error;
      }
      return;
    }

    try {
      const pin = await putPin(input);

      setPins((currentPins) => upsertPin(currentPins, pin));
    } catch (error) {
      setStatusMessage("Could not save this favorite.");
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
        setStatusMessage("Could not update this favorite.");
      });
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
        setStatusMessage("Could not update favorite highlight.");
      });
  }, []);

  const handleUnpin = useCallback((pin: TranslationPin) => {
    void deletePin(pin.id)
      .then(() => {
        setPins((currentPins) => currentPins.filter((currentPin) => !isSamePinTarget(currentPin, pin)));
      })
      .catch(() => {
        setStatusMessage("Could not remove this favorite.");
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

      const updatedRecord = await saveUserPaperContext(activeFingerprint, draft);

      setPaperContext(updatedRecord);
    },
    [activeFingerprint],
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
    [activeFingerprint, currentFileName, currentMetadataTitle],
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
      setStatusMessage("Could not clear favorites for this PDF.");
    });
  }, [handleClearCurrentPdfPins]);

  const handleClearTranslationCache = useCallback(async () => {
    await clearTranslationCache();
  }, []);

  const handleDeletePdfData = useCallback(
    async (fingerprint: string) => {
      await deletePdfLocalData(fingerprint);

      if (activeFingerprint === fingerprint) {
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
      applyPinnedTranslationCards,
      clearPinnedTranslationCardSaveTimer,
      refreshLibrary,
    ],
  );

  const handleClearCurrentPdfData = useCallback(async () => {
    if (!activeFingerprint) {
      return;
    }

    await handleDeletePdfData(activeFingerprint);
  }, [activeFingerprint, handleDeletePdfData]);

  const handleLocatePin = useCallback((pin: TranslationPin) => {
    locateRequestIdRef.current += 1;
    setLocateRequest({
      pin,
      requestId: locateRequestIdRef.current,
    });
  }, []);

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

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label="PDF Translate Reader">
          <span className="brand-mark">P</span>
          <span className="brand-text">PDF Translate Reader</span>
        </div>
        <div className="topbar-actions">
          <button
            aria-label={isLibraryPaneOpen ? "Close library pane" : "Open library pane"}
            aria-pressed={isLibraryPaneOpen}
            className="icon-button"
            onClick={() => setIsLibraryPaneOpen((isOpen) => !isOpen)}
            title={isLibraryPaneOpen ? "Close library" : "Open library"}
            type="button"
          >
            {isLibraryPaneOpen ? (
              <PanelLeftClose aria-hidden="true" size={17} strokeWidth={2} />
            ) : (
              <PanelLeftOpen aria-hidden="true" size={17} strokeWidth={2} />
            )}
          </button>
          <button
            aria-label={isPinsPaneOpen ? "Close favorites pane" : "Open favorites pane"}
            aria-pressed={isPinsPaneOpen}
            className="icon-button"
            onClick={() => setIsPinsPaneOpen((isOpen) => !isOpen)}
            title={isPinsPaneOpen ? "Close favorites" : "Open favorites"}
            type="button"
          >
            {isPinsPaneOpen ? (
              <PanelRightClose aria-hidden="true" size={17} strokeWidth={2} />
            ) : (
              <PanelRightOpen aria-hidden="true" size={17} strokeWidth={2} />
            )}
          </button>
          <span className={`api-health api-health--${apiStatus}`} title={`API ${apiStatus}`}>
            API
          </span>
          <div className="reader-mode-control" aria-label="Reader mode" role="group">
            <button
              aria-label="Translation mode"
              aria-pressed={readerMode === "translate"}
              className={`mode-toggle-button ${readerMode === "translate" ? "mode-toggle-button--active" : ""}`}
              onClick={() => handleReaderModeChange("translate")}
              title="Translation mode"
              type="button"
            >
              <Languages aria-hidden="true" size={16} strokeWidth={2} />
              <span>Translate</span>
            </button>
            <button
              aria-label="Text selection copy mode"
              aria-pressed={readerMode === "select"}
              className={`mode-toggle-button ${readerMode === "select" ? "mode-toggle-button--select" : ""}`}
              onClick={() => handleReaderModeChange("select")}
              title="Text selection copy mode"
              type="button"
            >
              <TextSelect aria-hidden="true" size={16} strokeWidth={2} />
              <span>Select</span>
            </button>
          </div>
          <div className="reader-mode-control" aria-label="Selection mode" role="group">
            <button
              aria-label="Continuous drag selection"
              aria-pressed={selectionMode === "continuous"}
              className={`mode-toggle-button ${
                selectionMode === "continuous" ? "mode-toggle-button--active" : ""
              }`}
              onClick={() => handleSelectionModeChange("continuous")}
              title="Continuous drag selection"
              type="button"
            >
              <MousePointer2 aria-hidden="true" size={16} strokeWidth={2} />
              <span>Drag</span>
            </button>
            <button
              aria-label="Cross-region selection"
              aria-pressed={selectionMode === "cross"}
              className={`mode-toggle-button ${
                selectionMode === "cross" ? "mode-toggle-button--cross" : ""
              }`}
              onClick={() => handleSelectionModeChange("cross")}
              title="Cross-region selection"
              type="button"
            >
              <Combine aria-hidden="true" size={16} strokeWidth={2} />
              <span>Cross</span>
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
        />
      ) : null}

      <main className="reader-workspace" style={workspaceStyle}>
        <aside
          className={`library-pane ${isLibraryPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isLibraryPaneOpen}
          aria-label="PDF library"
        >
          <div className="library-pane-header">
            <div className="pane-heading-row">
              <div className="pane-heading">Library</div>
              <button
                aria-label="Close library pane"
                className="icon-button icon-button--small"
                onClick={() => setIsLibraryPaneOpen(false)}
                title="Close library"
                type="button"
              >
                <PanelLeftClose aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </div>
            <PdfImportDropzone isImporting={isImporting} onImport={handleImport} variant="compact" />
          </div>
          {statusMessage ? <div className="pane-status">{statusMessage}</div> : null}
          <PdfLibrary
            activeFingerprint={activeFingerprint}
            entries={libraryEntries}
            onDelete={handleDeletePdfData}
            onOpen={handleOpenHistory}
            showControls
          />
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
              locateRequest={locateRequest}
              onActivateTranslationCard={handleActivateTranslationCard}
              onCloseTranslationCard={handleCloseTranslationCard}
              onPinTranslationCard={handlePinTranslationCard}
              onPinnedTranslationRefresh={handlePinnedTranslationRefresh}
              onPinTranslation={handlePinTranslation}
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
                    onOpen={handleOpenHistory}
                  />
                </div>
              ) : null}
            </div>
          )}
        </section>
        <div
          aria-label="Resize favorites pane"
          aria-orientation="vertical"
          className={`pane-resizer pane-resizer--pins ${isPinsPaneOpen ? "" : "pane-resizer--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("pins", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title="Resize favorites pane"
        />
        <aside
          className={`translation-pane ${isPinsPaneOpen ? "" : "pane--closed"}`}
          aria-hidden={!isPinsPaneOpen}
          aria-label="Favorite translations"
        >
          <div className="pane-heading-row">
            <div className="pane-heading">Favorites</div>
            <div className="pins-clear-actions">
              <button
                aria-label="Close favorites pane"
                className="icon-button icon-button--small"
                onClick={() => setIsPinsPaneOpen(false)}
                title="Close favorites"
                type="button"
              >
                <PanelRightClose aria-hidden="true" size={16} strokeWidth={2} />
              </button>
              {pins.length > 0 && isConfirmingClearPins ? (
                <>
                  <button
                    aria-label="Confirm clear all favorites"
                    className="icon-button icon-button--small icon-button--success"
                    onClick={handleClearPins}
                    title="Confirm clear all favorites"
                    type="button"
                  >
                    <Check aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                  <button
                    aria-label="Cancel clear all favorites"
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
                  aria-label="Clear all favorites"
                  className="icon-button icon-button--small"
                  onClick={() => setIsConfirmingClearPins(true)}
                  title="Clear all favorites"
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              ) : null}
            </div>
          </div>
          {pins.length > 0 ? (
            <div className="pins-pane-summary">
              {pins.length} favorite translation{pins.length === 1 ? "" : "s"}
            </div>
          ) : null}
          <PinnedTranslationsPanel
            onHighlightPin={handlePinHighlight}
            onLocatePin={handleLocatePin}
            onPinUpdated={handlePinUpdated}
            onUnpin={handleUnpin}
            paperContext={paperContext}
            pins={pins}
          />
        </aside>
      </main>
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
