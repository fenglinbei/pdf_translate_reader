import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Check, Trash2, X } from "lucide-react";
import {
  listPdfLibraryEntries,
  markPdfOpened,
  saveImportedPdf,
  updatePdfReadingPosition,
  type ReadingPositionUpdate,
} from "../cache/pdfLibraryRepository";
import { PdfImportDropzone } from "../pdf/PdfImportDropzone";
import { PdfLibrary } from "../pdf/PdfLibrary";
import { createPdfFingerprint } from "../pdf/pdfFingerprint";
import { PdfViewer, type PinLocateRequest } from "../pdf/PdfViewer";
import {
  deletePin,
  deletePinsByPdf,
  listPinsByPdf,
  putPin,
  updatePinTranslation,
  type PinWriteInput,
} from "../pins/pinRepository";
import { PinnedTranslationsPanel } from "../pins/PinnedTranslationsPanel";
import { SettingsButton } from "../settings/SettingsButton";
import type { PdfLibraryEntry, SentenceSelection, TranslationPin } from "../types/domain";
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
const PINS_PANE_MIN_WIDTH = 220;

export function ReaderShell() {
  const health = useApiHealth();
  const apiStatus = health.status === "ok" ? "online" : health.status;
  const [libraryEntries, setLibraryEntries] = useState<PdfLibraryEntry[]>([]);
  const [currentEntry, setCurrentEntry] = useState<PdfLibraryEntry>();
  const [isImporting, setIsImporting] = useState(false);
  const [libraryPaneWidth, setLibraryPaneWidth] = useState(LIBRARY_PANE_DEFAULT_WIDTH);
  const [isConfirmingClearPins, setIsConfirmingClearPins] = useState(false);
  const [locateRequest, setLocateRequest] = useState<PinLocateRequest>();
  const [pinsPaneWidth, setPinsPaneWidth] = useState(PINS_PANE_DEFAULT_WIDTH);
  const [pins, setPins] = useState<TranslationPin[]>([]);
  const [sentenceSelection, setSentenceSelection] = useState<SentenceSelection>();
  const [statusMessage, setStatusMessage] = useState<string>();
  const locateRequestIdRef = useRef(0);
  const paneResizeStateRef = useRef<PaneResizeState>();
  const pinsRef = useRef<TranslationPin[]>([]);
  const activeFingerprint = currentEntry?.fingerprint;

  const refreshLibrary = useCallback(async () => {
    setLibraryEntries(await listPdfLibraryEntries());
  }, []);

  useEffect(() => {
    void refreshLibrary().catch(() => {
      setStatusMessage("Could not read the local PDF library.");
    });
  }, [refreshLibrary]);

  useEffect(() => {
    pinsRef.current = pins;
    if (pins.length === 0) {
      setIsConfirmingClearPins(false);
    }
  }, [pins]);

  useEffect(() => {
    if (!activeFingerprint) {
      setPins([]);
      setIsConfirmingClearPins(false);
      return undefined;
    }

    setIsConfirmingClearPins(false);
    let cancelled = false;

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
          setStatusMessage("Could not read saved pins for this PDF.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeFingerprint]);

  const handleImport = useCallback(
    async (file: File) => {
      setIsImporting(true);
      setStatusMessage(undefined);

      try {
        const identity = await createPdfFingerprint(file);
        const entry = await saveImportedPdf({
          ...identity,
          blob: file.slice(0, file.size, "application/pdf"),
        });

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
        setPins([]);
        await refreshLibrary();
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Could not import this PDF.");
      } finally {
        setIsImporting(false);
      }
    },
    [refreshLibrary],
  );

  const handleOpenHistory = useCallback(
    async (fingerprint: string) => {
      setStatusMessage(undefined);

      try {
        const entry = await markPdfOpened(fingerprint);

        setCurrentEntry(entry);
        setSentenceSelection(undefined);
        setPins([]);
        await refreshLibrary();
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : "Could not open this PDF.");
      }
    },
    [refreshLibrary],
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

  const handleCloseActiveSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSentenceSelection(undefined);
  }, []);

  const handlePinTranslation = useCallback(async (input: PinWriteInput) => {
    try {
      const pin = await putPin(input);

      setPins((currentPins) => upsertPin(currentPins, pin));
    } catch (error) {
      setStatusMessage("Could not save this pin.");
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
        setStatusMessage("Could not update this pin.");
      });
  }, []);

  const handlePinUpdated = useCallback((pin: TranslationPin) => {
    setPins((currentPins) => upsertPin(currentPins, pin));
  }, []);

  const handleUnpin = useCallback((pin: TranslationPin) => {
    void deletePin(pin.id)
      .then(() => {
        setPins((currentPins) => currentPins.filter((currentPin) => !isSamePinTarget(currentPin, pin)));
      })
      .catch(() => {
        setStatusMessage("Could not remove this pin.");
      });
  }, []);

  const handleClearPins = useCallback(() => {
    if (!activeFingerprint) {
      return;
    }

    void deletePinsByPdf(activeFingerprint)
      .then(() => {
        setPins([]);
        setIsConfirmingClearPins(false);
      })
      .catch(() => {
        setStatusMessage("Could not clear pins for this PDF.");
      });
  }, [activeFingerprint]);

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
          <span className={`api-health api-health--${apiStatus}`} title={`API ${apiStatus}`}>
            API
          </span>
          <SettingsButton />
        </div>
      </header>

      <main className="reader-workspace" style={workspaceStyle}>
        <aside className="library-pane" aria-label="PDF library">
          <div className="library-pane-header">
            <div className="pane-heading">Library</div>
            <PdfImportDropzone isImporting={isImporting} onImport={handleImport} variant="compact" />
          </div>
          {statusMessage ? <div className="pane-status">{statusMessage}</div> : null}
          <PdfLibrary
            activeFingerprint={activeFingerprint}
            entries={libraryEntries}
            onOpen={handleOpenHistory}
          />
        </aside>
        <div
          aria-label="Resize library pane"
          aria-orientation="vertical"
          className="pane-resizer pane-resizer--library"
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
              activeSelection={sentenceSelection}
              entry={currentEntry}
              locateRequest={locateRequest}
              onActiveSelectionClose={handleCloseActiveSelection}
              onPinnedTranslationRefresh={handlePinnedTranslationRefresh}
              onPinTranslation={handlePinTranslation}
              onReadingPositionChange={handleReadingPositionChange}
              onSentenceSelectionChange={setSentenceSelection}
              pins={pins}
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
          aria-label="Resize pins pane"
          aria-orientation="vertical"
          className="pane-resizer pane-resizer--pins"
          onPointerCancel={handlePaneResizeEnd}
          onPointerDown={(event) => handlePaneResizeStart("pins", event)}
          onPointerMove={handlePaneResizeMove}
          onPointerUp={handlePaneResizeEnd}
          role="separator"
          title="Resize pins pane"
        />
        <aside className="translation-pane" aria-label="Pinned translations">
          <div className="pane-heading-row">
            <div className="pane-heading">Pins</div>
            {pins.length > 0 ? (
              <div className="pins-clear-actions">
                {isConfirmingClearPins ? (
                  <>
                    <button
                      aria-label="Confirm clear all pins"
                      className="icon-button icon-button--small icon-button--success"
                      onClick={handleClearPins}
                      title="Confirm clear all pins"
                      type="button"
                    >
                      <Check aria-hidden="true" size={16} strokeWidth={2} />
                    </button>
                    <button
                      aria-label="Cancel clear all pins"
                      className="icon-button icon-button--small icon-button--danger"
                      onClick={() => setIsConfirmingClearPins(false)}
                      title="Cancel"
                      type="button"
                    >
                      <X aria-hidden="true" size={16} strokeWidth={2} />
                    </button>
                  </>
                ) : (
                  <button
                    aria-label="Clear all pins"
                    className="icon-button icon-button--small"
                    onClick={() => setIsConfirmingClearPins(true)}
                    title="Clear all pins"
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                )}
              </div>
            ) : null}
          </div>
          {pins.length > 0 ? (
            <div className="pins-pane-summary">
              {pins.length} pinned translation{pins.length === 1 ? "" : "s"}
            </div>
          ) : null}
          <PinnedTranslationsPanel
            onLocatePin={handleLocatePin}
            onPinUpdated={handlePinUpdated}
            onUnpin={handleUnpin}
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
