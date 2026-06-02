import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { Minus, Plus } from "lucide-react";
import { pdfjsLib } from "./pdfjs";
import type { PinWriteInput } from "../pins/pinRepository";
import type { AppSettings, PdfLibraryEntry, SentenceSelection, TranslationPin } from "../types/domain";
import type { ReadingPositionUpdate } from "../cache/pdfLibraryRepository";
import {
  createPageTextIndex,
  getTextSpanPointerHit,
  getTextSpanPointerHitFromPoint,
  pointerHitRangeToWordSelection,
  pointerHitToSentenceSelection,
  type TextSpanPointerHit,
  type PageTextIndex,
} from "../selection/selectionToSpan";
import { PageOverlayLayer } from "./pageOverlayLayer";

type PdfViewerProps = {
  activeSelection?: SentenceSelection;
  entry: PdfLibraryEntry;
  locateRequest?: PinLocateRequest;
  onActiveSelectionClose: () => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (input: PinWriteInput) => Promise<void>;
  onReadingPositionChange: (position: ReadingPositionUpdate) => void;
  onSentenceSelectionChange: (selection: SentenceSelection | undefined) => void;
  pins: TranslationPin[];
  settings: AppSettings;
};

export type PinLocateRequest = {
  pin: TranslationPin;
  requestId: number;
};

type PdfDocumentProxy = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
type RenderTask = ReturnType<PdfPageProxy["render"]>;

type PageDescriptor = {
  height: number;
  pageNumber: number;
  width: number;
};

type SpanDragState = {
  latestHit: TextSpanPointerHit;
  pointerId: number;
  startHit: TextSpanPointerHit;
  startX: number;
  startY: number;
};
type PanDragState = {
  pointerId: number;
  startScrollLeft: number;
  startScrollTop: number;
  startX: number;
  startY: number;
};
type ZoomAnchor = {
  offsetX: number;
  offsetY: number;
  scrollLeft: number;
  scrollTop: number;
  scaleRatio: number;
};

const MAX_RENDER_SCALE = 1.35;
const MIN_RENDER_SCALE = 0.7;
const POINTER_DRAG_THRESHOLD_PX = 8;
const TARGET_FORWARD_SENTENCE_COUNT = 0;
const MAX_TARGET_SENTENCE_COUNT = 4;
const USER_ZOOM_MAX = 2.4;
const USER_ZOOM_MIN = 0.6;
const USER_ZOOM_STEP = 0.1;

export function PdfViewer({
  activeSelection,
  entry,
  locateRequest,
  onActiveSelectionClose,
  onPinnedTranslationRefresh,
  onPinTranslation,
  onReadingPositionChange,
  onSentenceSelectionChange,
  pins,
  settings,
}: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageIndexesRef = useRef(new Map<number, PageTextIndex>());
  const locatedPinTimerRef = useRef<number>();
  const panDragRef = useRef<PanDragState>();
  const saveTimerRef = useRef<number>();
  const pendingPositionRef = useRef<ReadingPositionUpdate>();
  const restoredFingerprintRef = useRef<string>();
  const spanDragRef = useRef<SpanDragState>();
  const draftSelectionRef = useRef<SentenceSelection>();
  const zoomAnchorRef = useRef<ZoomAnchor>();
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy>();
  const [pages, setPages] = useState<PageDescriptor[]>([]);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [isPanning, setIsPanning] = useState(false);
  const [draftSelection, setDraftSelection] = useState<SentenceSelection>();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [locatedPinId, setLocatedPinId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [userZoom, setUserZoom] = useState(1);

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      setAvailableWidth(Math.max(320, entry.contentRect.width - 48));
    });

    resizeObserver.observe(scrollElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PdfDocumentProxy | undefined;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | undefined;

    setLoadState("loading");
    setErrorMessage(undefined);
    setPages([]);
    setPdfDocument(undefined);
    setUserZoom(1);
    setDraftSelection(undefined);
    pageIndexesRef.current = new Map();
    draftSelectionRef.current = undefined;
    restoredFingerprintRef.current = undefined;
    onSentenceSelectionChange(undefined);

    async function loadDocument() {
      try {
        const arrayBuffer = await entry.blob.arrayBuffer();

        if (cancelled) {
          return;
        }

        loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(arrayBuffer),
        });
        loadedDocument = await loadingTask.promise;
        const descriptors = await loadPageDescriptors(loadedDocument);

        if (cancelled) {
          await loadedDocument.destroy().catch(() => undefined);
          return;
        }

        setPdfDocument(loadedDocument);
        setPages(descriptors);
        setLoadState("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }

        setLoadState("error");
        setErrorMessage(error instanceof Error ? error.message : "Unable to open this PDF.");
      }
    }

    void loadDocument();

    return () => {
      cancelled = true;
      if (loadedDocument) {
        void loadedDocument.destroy().catch(() => undefined);
      } else if (loadingTask) {
        void loadingTask.destroy().catch(() => undefined);
      }
    };
  }, [entry.blob, entry.fingerprint, onSentenceSelectionChange]);

  const baseScale = useMemo(() => {
    const widestPage = pages.reduce((width, page) => Math.max(width, page.width), 612);
    const nextScale = availableWidth / widestPage;

    return Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, nextScale));
  }, [availableWidth, pages]);
  const scale = useMemo(() => baseScale * userZoom, [baseScale, userZoom]);

  const flushReadingPosition = useCallback(() => {
    if (!pendingPositionRef.current) {
      return;
    }

    onReadingPositionChange(pendingPositionRef.current);
    pendingPositionRef.current = undefined;
  }, [onReadingPositionChange]);

  const queueReadingPosition = useCallback(
    (position: ReadingPositionUpdate) => {
      pendingPositionRef.current = position;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(flushReadingPosition, 300);
    },
    [flushReadingPosition],
  );

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current);
      flushReadingPosition();
    };
  }, [flushReadingPosition]);

  useEffect(() => {
    return () => {
      window.clearTimeout(locatedPinTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const zoomAnchor = zoomAnchorRef.current;
    const scrollElement = scrollRef.current;

    if (!zoomAnchor || !scrollElement) {
      return;
    }

    zoomAnchorRef.current = undefined;
    window.requestAnimationFrame(() => {
      scrollElement.scrollLeft =
        (zoomAnchor.scrollLeft + zoomAnchor.offsetX) * zoomAnchor.scaleRatio - zoomAnchor.offsetX;
      scrollElement.scrollTop =
        (zoomAnchor.scrollTop + zoomAnchor.offsetY) * zoomAnchor.scaleRatio - zoomAnchor.offsetY;
    });
  }, [scale]);

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement || pages.length === 0 || restoredFingerprintRef.current === entry.fingerprint) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (typeof entry.lastScrollTop === "number") {
        scrollElement.scrollTop = entry.lastScrollTop;
      } else if (typeof entry.lastPageIndex === "number") {
        const pageElement = scrollElement.querySelector<HTMLElement>(
          `[data-page-index="${entry.lastPageIndex}"]`,
        );

        scrollElement.scrollTop = pageElement ? getScrollTopForElement(scrollElement, pageElement) : 0;
      } else {
        scrollElement.scrollTop = 0;
      }

      restoredFingerprintRef.current = entry.fingerprint;
    });
  }, [entry.fingerprint, entry.lastPageIndex, entry.lastScrollTop, pages.length, scale]);

  const handleScroll = useCallback(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return;
    }

    queueReadingPosition({
      lastPageIndex: getCurrentPageIndex(scrollElement),
      lastScrollTop: scrollElement.scrollTop,
    });
  }, [queueReadingPosition]);

  const handleZoom = useCallback(
    (direction: 1 | -1, anchor?: { clientX: number; clientY: number }) => {
      const scrollElement = scrollRef.current;

      if (!scrollElement) {
        return;
      }

      setUserZoom((currentZoom) => {
        const nextZoom = roundZoom(
          clamp(currentZoom + direction * USER_ZOOM_STEP, USER_ZOOM_MIN, USER_ZOOM_MAX),
        );

        if (nextZoom === currentZoom) {
          return currentZoom;
        }

        const scrollRect = scrollElement.getBoundingClientRect();
        const offsetX = (anchor?.clientX ?? scrollRect.left + scrollRect.width / 2) - scrollRect.left;
        const offsetY = (anchor?.clientY ?? scrollRect.top + scrollRect.height / 2) - scrollRect.top;

        zoomAnchorRef.current = {
          offsetX,
          offsetY,
          scaleRatio: nextZoom / currentZoom,
          scrollLeft: scrollElement.scrollLeft,
          scrollTop: scrollElement.scrollTop,
        };

        return nextZoom;
      });
    },
    [],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!event.altKey) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handleZoom(event.deltaY < 0 ? 1 : -1, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    [handleZoom],
  );

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return undefined;
    }

    scrollElement.addEventListener("wheel", handleWheel, {
      capture: true,
      passive: false,
    });

    return () => {
      scrollElement.removeEventListener("wheel", handleWheel, {
        capture: true,
      });
    };
  }, [handleWheel]);

  const handleAuxClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  }, []);

  const addPageMetricsToSelection = useCallback(
    (selection: SentenceSelection): SentenceSelection => {
      const pageDescriptor = pages.find((page) => page.pageNumber - 1 === selection.pageIndex);

      return {
        ...selection,
        pageHeight: pageDescriptor ? pageDescriptor.height * scale : undefined,
        pageWidth: pageDescriptor ? pageDescriptor.width * scale : undefined,
      };
    },
    [pages, scale],
  );

  const updateDraftSelection = useCallback(
    (selection: SentenceSelection | undefined) => {
      const nextSelection = selection ? addPageMetricsToSelection(selection) : undefined;

      draftSelectionRef.current = nextSelection;
      setDraftSelection(nextSelection);
    },
    [addPageMetricsToSelection],
  );

  const handleTextPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) {
      const scrollElement = scrollRef.current;

      if (!scrollElement) {
        return;
      }

      panDragRef.current = {
        pointerId: event.pointerId,
        startScrollLeft: scrollElement.scrollLeft,
        startScrollTop: scrollElement.scrollTop,
        startX: event.clientX,
        startY: event.clientY,
      };
      setIsPanning(true);
      window.getSelection()?.removeAllRanges();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const pointerHit = getTextSpanPointerHit(event.target, event.clientX, event.clientY);

    if (!pointerHit) {
      return;
    }

    draftSelectionRef.current = undefined;
    setDraftSelection(undefined);
    onSentenceSelectionChange(undefined);
    spanDragRef.current = {
      latestHit: pointerHit,
      pointerId: event.pointerId,
      startHit: pointerHit,
      startX: event.clientX,
      startY: event.clientY,
    };
    window.getSelection()?.removeAllRanges();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [onSentenceSelectionChange]);

  const handleTextPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const panDragState = panDragRef.current;
      const scrollElement = scrollRef.current;

      if (panDragState && scrollElement && panDragState.pointerId === event.pointerId) {
        scrollElement.scrollLeft = panDragState.startScrollLeft - (event.clientX - panDragState.startX);
        scrollElement.scrollTop = panDragState.startScrollTop - (event.clientY - panDragState.startY);
        event.preventDefault();
        return;
      }

      const dragState = spanDragRef.current;

      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const pointerHit = getTextSpanPointerHitFromPoint(event.clientX, event.clientY);

      if (pointerHit && pointerHit.pageIndex === dragState.startHit.pageIndex) {
        dragState.latestHit = pointerHit;
      }

      const movedDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      const isRangeDrag =
        movedDistance >= POINTER_DRAG_THRESHOLD_PX &&
        dragState.latestHit.pageIndex === dragState.startHit.pageIndex &&
        dragState.latestHit.rawOffset !== dragState.startHit.rawOffset;

      updateDraftSelection(
        isRangeDrag
          ? pointerHitRangeToWordSelection({
              contextWindowSize: settings.contextWindowN,
              endHit: dragState.latestHit,
              maxSentenceCount: MAX_TARGET_SENTENCE_COUNT,
              maxWordCount: settings.maxDraggedWords,
              pageIndexes: pageIndexesRef.current,
              pdfFingerprint: entry.fingerprint,
              startHit: dragState.startHit,
            })
          : undefined,
      );

      event.preventDefault();
    },
    [entry.fingerprint, settings.contextWindowN, settings.maxDraggedWords, updateDraftSelection],
  );

  const handleTextPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (panDragRef.current?.pointerId === event.pointerId) {
        panDragRef.current = undefined;
        setIsPanning(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
        event.preventDefault();
        return;
      }

      const dragState = spanDragRef.current;

      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const pointerHit = getTextSpanPointerHitFromPoint(event.clientX, event.clientY);
      const endHit =
        pointerHit && pointerHit.pageIndex === dragState.startHit.pageIndex
          ? pointerHit
          : dragState.latestHit;
      const movedDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      const isRangeDrag =
        movedDistance >= POINTER_DRAG_THRESHOLD_PX &&
        endHit.pageIndex === dragState.startHit.pageIndex &&
        endHit.rawOffset !== dragState.startHit.rawOffset;
      const sentenceSelection = isRangeDrag
        ? draftSelectionRef.current ??
          (pointerHitRangeToWordSelection({
            contextWindowSize: settings.contextWindowN,
            endHit,
            maxSentenceCount: MAX_TARGET_SENTENCE_COUNT,
            maxWordCount: settings.maxDraggedWords,
            pageIndexes: pageIndexesRef.current,
            pdfFingerprint: entry.fingerprint,
            startHit: dragState.startHit,
          }) ?? undefined)
        : pointerHitToSentenceSelection({
            contextWindowSize: settings.contextWindowN,
            forwardSentenceCount: TARGET_FORWARD_SENTENCE_COUNT,
            maxSentenceCount: MAX_TARGET_SENTENCE_COUNT,
            pageIndexes: pageIndexesRef.current,
            pdfFingerprint: entry.fingerprint,
            pointerHit: dragState.startHit,
          });

      spanDragRef.current = undefined;
      draftSelectionRef.current = undefined;
      setDraftSelection(undefined);
      window.getSelection()?.removeAllRanges();
      event.currentTarget.releasePointerCapture(event.pointerId);
      event.preventDefault();

      if (sentenceSelection) {
        onSentenceSelectionChange(addPageMetricsToSelection(sentenceSelection));
      }
    },
    [
      addPageMetricsToSelection,
      entry.fingerprint,
      onSentenceSelectionChange,
      settings.contextWindowN,
      settings.maxDraggedWords,
    ],
  );

  const handleTextPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId === event.pointerId) {
      panDragRef.current = undefined;
      setIsPanning(false);
    }

    if (spanDragRef.current?.pointerId === event.pointerId) {
      spanDragRef.current = undefined;
      draftSelectionRef.current = undefined;
      setDraftSelection(undefined);
    }
  }, []);

  const handleTextIndexReady = useCallback((pageTextIndex: PageTextIndex) => {
    pageIndexesRef.current.set(pageTextIndex.pageIndex, pageTextIndex);
  }, []);

  const handleTextIndexClear = useCallback((pageIndex: number) => {
    pageIndexesRef.current.delete(pageIndex);
  }, []);

  const handleLocatePin = useCallback((pin: TranslationPin) => {
    const scrollElement = scrollRef.current;

    if (!scrollElement || pin.rectsOnPage.length === 0) {
      return;
    }

    const pageElement = scrollElement.querySelector<HTMLElement>(
      `[data-page-index="${pin.pageIndex}"]`,
    );

    if (!pageElement) {
      return;
    }

    const currentPageHeight = pageElement.getBoundingClientRect().height || pageElement.offsetHeight;
    const scaleY = pin.pageHeight && pin.pageHeight > 0 ? currentPageHeight / pin.pageHeight : 1;
    const anchorTop = Math.min(...pin.rectsOnPage.map((rect) => rect.top)) * scaleY;
    const pageScrollTop = getScrollTopForElement(scrollElement, pageElement);
    const targetScrollTop = Math.max(
      0,
      pageScrollTop + anchorTop - scrollElement.clientHeight * 0.24,
    );

    scrollElement.scrollTo({
      behavior: "smooth",
      top: targetScrollTop,
    });

    setLocatedPinId(pin.id);
    window.clearTimeout(locatedPinTimerRef.current);
    locatedPinTimerRef.current = window.setTimeout(() => {
      setLocatedPinId((currentPinId) => (currentPinId === pin.id ? undefined : currentPinId));
    }, 1500);
  }, []);

  useEffect(() => {
    if (locateRequest) {
      handleLocatePin(locateRequest.pin);
    }
  }, [handleLocatePin, locateRequest]);

  return (
    <div className="pdf-viewer-shell">
      <div className="pdf-viewer-header">
        <div>
          <div className="pdf-viewer-title">{entry.pdfMetadata?.title || entry.fileName}</div>
          <div className="pdf-viewer-subtitle">
            {pages.length > 0 ? `${pages.length} pages` : "Loading PDF"}
          </div>
        </div>
        <div className="pdf-viewer-actions" aria-label="PDF zoom controls">
          <button
            aria-label="Zoom out"
            className="icon-button icon-button--small"
            disabled={userZoom <= USER_ZOOM_MIN}
            onClick={() => handleZoom(-1)}
            title="Zoom out"
            type="button"
          >
            <Minus aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <span className="pdf-zoom-value">{Math.round(userZoom * 100)}%</span>
          <button
            aria-label="Zoom in"
            className="icon-button icon-button--small"
            disabled={userZoom >= USER_ZOOM_MAX}
            onClick={() => handleZoom(1)}
            title="Zoom in"
            type="button"
          >
            <Plus aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div
        className={`pdf-scroll-region ${isPanning ? "pdf-scroll-region--panning" : ""} ${
          draftSelection ? "pdf-scroll-region--selecting" : ""
        }`}
        onAuxClick={handleAuxClick}
        onPointerCancel={handleTextPointerCancel}
        onPointerDown={handleTextPointerDown}
        onPointerMove={handleTextPointerMove}
        onPointerUp={handleTextPointerUp}
        onScroll={handleScroll}
        ref={scrollRef}
      >
        {loadState === "error" ? (
          <div className="reader-message">{errorMessage}</div>
        ) : (
          <div className="pdf-page-list">
            {pdfDocument && pages.length > 0
              ? pages.map((page) => (
                  <PdfPageView
                    activeSelection={activeSelection}
                    descriptor={page}
                    draftSelection={draftSelection}
                    key={`${entry.fingerprint}-${page.pageNumber}`}
                    onActiveSelectionClose={onActiveSelectionClose}
                    onPinnedTranslationRefresh={onPinnedTranslationRefresh}
                    onPinTranslation={onPinTranslation}
                    onTextIndexClear={handleTextIndexClear}
                    onTextIndexReady={handleTextIndexReady}
                    pdfDocument={pdfDocument}
                    pins={pins}
                    locatedPinId={locatedPinId}
                    scale={scale}
                    settings={settings}
                  />
                ))
              : <div className="reader-message">Loading PDF...</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfPageView({
  activeSelection,
  descriptor,
  draftSelection,
  locatedPinId,
  onActiveSelectionClose,
  onPinnedTranslationRefresh,
  onPinTranslation,
  onTextIndexClear,
  onTextIndexReady,
  pdfDocument,
  pins,
  scale,
  settings,
}: {
  activeSelection?: SentenceSelection;
  descriptor: PageDescriptor;
  draftSelection?: SentenceSelection;
  locatedPinId?: string;
  onActiveSelectionClose: () => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (input: PinWriteInput) => Promise<void>;
  onTextIndexClear: (pageIndex: number) => void;
  onTextIndexReady: (pageTextIndex: PageTextIndex) => void;
  pdfDocument: PdfDocumentProxy;
  pins: TranslationPin[];
  scale: number;
  settings: AppSettings;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [renderState, setRenderState] = useState<"rendering" | "ready" | "error">("rendering");

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: InstanceType<typeof pdfjsLib.TextLayer> | undefined;

    async function renderPage() {
      setRenderState("rendering");

      try {
        const page = await pdfDocument.getPage(descriptor.pageNumber);

        if (cancelled) {
          return;
        }

        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const pageElement = pageRef.current;
        const textLayerElement = textLayerRef.current;
        const outputScale = window.devicePixelRatio || 1;

        if (!canvas || !pageElement || !textLayerElement) {
          return;
        }

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Canvas is not available.");
        }

        pageElement.style.width = `${viewport.width}px`;
        pageElement.style.height = `${viewport.height}px`;
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);

        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--scale-factor", `${scale}`);

        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;

        if (cancelled) {
          return;
        }

        const textContent = await page.getTextContent();
        textLayer = new pdfjsLib.TextLayer({
          container: textLayerElement,
          textContentSource: textContent,
          viewport,
        });
        await textLayer.render();

        if (!cancelled) {
          onTextIndexReady(
            createPageTextIndex({
              pageElement,
              pageIndex: descriptor.pageNumber - 1,
              textContent,
              textDivs: textLayer.textDivs,
              textLayerElement,
            }),
          );
          setRenderState("ready");
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        if (error instanceof Error && error.name === "RenderingCancelledException") {
          return;
        }

        setRenderState("error");
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      onTextIndexClear(descriptor.pageNumber - 1);
      textLayer?.cancel();
      renderTask?.cancel();
    };
  }, [descriptor.pageNumber, onTextIndexClear, onTextIndexReady, pdfDocument, scale]);

  return (
    <div
      className={`pdf-page pdf-page--${renderState}`}
      data-page-index={descriptor.pageNumber - 1}
      ref={pageRef}
      style={{
        height: descriptor.height * scale,
        width: descriptor.width * scale,
      }}
    >
      <canvas className="pdf-page-canvas" ref={canvasRef} />
      <div className="textLayer pdf-text-layer" ref={textLayerRef} />
      <PageOverlayLayer
        locatedPinId={locatedPinId}
        onCloseSelection={onActiveSelectionClose}
        onPinnedTranslationRefresh={onPinnedTranslationRefresh}
        onPinTranslation={onPinTranslation}
        pageHeight={descriptor.height * scale}
        pageIndex={descriptor.pageNumber - 1}
        pageWidth={descriptor.width * scale}
        pins={pins}
        draftSelection={draftSelection}
        selection={activeSelection}
        settings={settings}
      />
      {renderState === "error" ? <div className="pdf-page-error">Page failed to render.</div> : null}
    </div>
  );
}

async function loadPageDescriptors(pdfDocument: PdfDocumentProxy) {
  const descriptors: PageDescriptor[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    descriptors.push({
      height: viewport.height,
      pageNumber,
      width: viewport.width,
    });
  }

  return descriptors;
}

function getCurrentPageIndex(scrollElement: HTMLElement) {
  const midpoint = scrollElement.scrollTop + scrollElement.clientHeight * 0.35;
  const pageElements = Array.from(
    scrollElement.querySelectorAll<HTMLElement>("[data-page-index]"),
  );
  let currentPageIndex = 0;

  for (const pageElement of pageElements) {
    if (pageElement.offsetTop <= midpoint) {
      currentPageIndex = Number(pageElement.dataset.pageIndex ?? 0);
    }
  }

  return currentPageIndex;
}

function getScrollTopForElement(scrollElement: HTMLElement, targetElement: HTMLElement) {
  const scrollRect = scrollElement.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();

  return Math.max(0, targetRect.top - scrollRect.top + scrollElement.scrollTop);
}

function roundZoom(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
