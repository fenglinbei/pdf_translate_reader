import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  TouchEvent as ReactTouchEvent,
} from "react";
import { Minus, Plus } from "lucide-react";
import { pdfjsLib } from "./pdfjs";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { useI18n } from "../i18n/I18nProvider";
import type { PinAnnotationInput, PinWriteInput } from "../pins/pinRepository";
import type {
  AppSettings,
  MobileBaseMode,
  MobileInteractionMode,
  PaperContext,
  PdfLibraryEntry,
  ReaderMode,
  SelectionMode,
  SelectionRegion,
  SentenceSelection,
  TranslationPin,
} from "../types/domain";
import type { ReadingPositionUpdate } from "../cache/pdfLibraryRepository";
import type {
  PinnedTranslationCard,
  TranslationCardPinInput,
  TranslationFavoriteAction,
  TranslationCardViewChange,
  TranslationCardViewChangeOptions,
} from "../translation/floatingCardTypes";
import {
  createPageTextIndex,
  createPageTextMetadata,
  getTextSpanPointerHit,
  getTextSpanPointerHitFromPoint,
  pointerHitRangeToWordSelection,
  type TextSpanPointerHit,
  type PageTextMetadata,
  type PageTextIndex,
} from "../selection/selectionToSpan";
import {
  CROSS_PAGE_SELECTION_MESSAGE,
  OCR_UNSUPPORTED_MESSAGE,
  getTextOrderWarning,
  hasUsableTextLayerText,
  isCrossPageSelection,
} from "../selection/edgeCases";
import { normalizeSentence } from "../selection/sentenceBoundary";
import { PageOverlayLayer } from "./pageOverlayLayer";

type PdfViewerProps = {
  activeTranslationCardZIndex: number;
  activeSelection?: SentenceSelection;
  entry: PdfLibraryEntry;
  headerControls?: ReactNode;
  locateRequest?: PinLocateRequest;
  onActivateTranslationCard: (selection: SentenceSelection) => void;
  onCloseTranslationCard: (selection: SentenceSelection) => void;
  onCreateAnnotation: (
    selection: SentenceSelection,
    annotation: PinAnnotationInput,
  ) => Promise<void>;
  onDocumentLoadError?: (fingerprint: string, message: string) => void;
  onPinTranslationCard: (input: TranslationCardPinInput) => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onRemoveLocalRecord?: (fingerprint: string) => Promise<void> | void;
  onPinTranslation: (
    input: PinWriteInput,
    action: TranslationFavoriteAction,
  ) => Promise<void>;
  onPageTextReadyForPaperContext: (pageIndex: number, text: string) => void;
  onReadingPositionChange: (position: ReadingPositionUpdate) => void;
  onRevealPinCard: (pin: TranslationPin) => void;
  onSentenceSelectionChange: (selection: SentenceSelection | undefined) => void;
  onTranslationCardViewChange: (
    selection: SentenceSelection,
    viewChange: TranslationCardViewChange,
    options?: TranslationCardViewChangeOptions,
  ) => void;
  mobileBaseMode: MobileBaseMode;
  mobileInteractionMode: MobileInteractionMode;
  pinnedTranslationCards: PinnedTranslationCard[];
  paperContext?: PaperContext;
  pins: TranslationPin[];
  readerMode: ReaderMode;
  selectionMode: SelectionMode;
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
type PageLayout = {
  heights: number[];
  tops: number[];
};
type CachedPageText = {
  content: TextContent;
  metadata: PageTextMetadata;
  hasUsableText: boolean;
};
type PdfPageStyle = CSSProperties & {
  "--pdf-page-height": string;
  "--pdf-page-width": string;
};
type PdfPageListStyle = CSSProperties & {
  "--pdf-display-scale": number;
  "--pdf-render-scale": number;
  "--pdf-scale-ratio": number;
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
type PinchZoomState = {
  startDistance: number;
  startZoom: number;
};
type TouchPointCollection = {
  [index: number]: {
    clientX: number;
    clientY: number;
  };
  length: number;
};
type ZoomAnchor = {
  offsetX: number;
  offsetY: number;
  scrollLeft: number;
  scrollTop: number;
  scaleRatio: number;
};
type LocatableSelection = {
  pageHeight?: number;
  pageIndex: number;
  rectsOnPage: Array<{
    top: number;
  }>;
};

const MAX_RENDER_SCALE = 1.35;
const MAX_PDF_RENDER_SCALE = 2;
const MAX_CANVAS_OUTPUT_SCALE = 1.5;
const MOBILE_MAX_CANVAS_OUTPUT_SCALE = 1.25;
const MOBILE_MAX_RENDER_SCALE = 1.2;
const MIN_RENDER_SCALE = 0.7;
const PDF_PAGE_GAP_PX = 18;
const PDF_PAGE_LIST_PADDING_PX = 24;
const MOBILE_PDF_PAGE_GAP_PX = 12;
const MOBILE_PDF_PAGE_LIST_PADDING_PX = 10;
const PAGE_RENDER_OVERSCAN = 1;
const POINTER_DRAG_THRESHOLD_PX = 8;
const REAL_ZOOM_COMMIT_DELAY_MS = 180;
const USER_ZOOM_MAX = 2.4;
const USER_ZOOM_MIN = 0.6;
const USER_ZOOM_STEP = 0.1;

export function PdfViewer({
  activeTranslationCardZIndex,
  activeSelection,
  entry,
  headerControls,
  locateRequest,
  onActivateTranslationCard,
  onCloseTranslationCard,
  onCreateAnnotation,
  onDocumentLoadError,
  onPageTextReadyForPaperContext,
  onPinTranslationCard,
  onPinnedTranslationRefresh,
  onRemoveLocalRecord,
  onPinTranslation,
  onReadingPositionChange,
  onRevealPinCard,
  onSentenceSelectionChange,
  onTranslationCardViewChange,
  mobileBaseMode,
  mobileInteractionMode,
  pinnedTranslationCards,
  paperContext,
  pins,
  readerMode,
  selectionMode,
  settings,
}: PdfViewerProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageIndexesRef = useRef(new Map<number, PageTextIndex>());
  const emphasizedPinnedCardTimerRef = useRef<number>();
  const locatedPinTimerRef = useRef<number>();
  const revealPinnedCardTimerRef = useRef<number>();
  const panDragRef = useRef<PanDragState>();
  const saveTimerRef = useRef<number>();
  const selectionNoticeTimerRef = useRef<number>();
  const pendingPositionRef = useRef<ReadingPositionUpdate>();
  const pinchZoomRef = useRef<PinchZoomState>();
  const restoredFingerprintRef = useRef<string>();
  const spanDragRef = useRef<SpanDragState>();
  const queuedCrossSelectionsRef = useRef<SentenceSelection[]>([]);
  const draftSelectionRef = useRef<SentenceSelection>();
  const realZoomCommitTimerRef = useRef<number>();
  const textContentCacheRef = useRef(new Map<number, CachedPageText>());
  const userZoomRef = useRef(1);
  const zoomAnchorRef = useRef<ZoomAnchor>();
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy>();
  const [pages, setPages] = useState<PageDescriptor[]>([]);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [baseScale, setBaseScale] = useState<number>();
  const [hasMeasuredAvailableWidth, setHasMeasuredAvailableWidth] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [draftSelection, setDraftSelection] = useState<SentenceSelection>();
  const [queuedCrossSelections, setQueuedCrossSelections] = useState<SentenceSelection[]>([]);
  const [copyNotice, setCopyNotice] = useState<string>();
  const [copiedSelection, setCopiedSelection] = useState<SentenceSelection>();
  const [confirmedMobileReaderMode, setConfirmedMobileReaderMode] = useState<ReaderMode>();
  const [collapsedMobileSelectionKey, setCollapsedMobileSelectionKey] = useState<string>();
  const [activeMobilePinnedCardKey, setActiveMobilePinnedCardKey] = useState<string>();
  const [emphasizedPinnedCardKey, setEmphasizedPinnedCardKey] = useState<string>();
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [locatedPinId, setLocatedPinId] = useState<string>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [selectionNotice, setSelectionNotice] = useState<string>();
  const [mobilePendingSelection, setMobilePendingSelection] = useState<SentenceSelection>();
  const [renderPageIndexes, setRenderPageIndexes] = useState<Set<number>>(() => new Set());
  const [renderZoom, setRenderZoom] = useState(1);
  const [userZoom, setUserZoom] = useState(1);
  const isMobileSegmentedSelectionMode =
    isMobileViewport &&
    mobileBaseMode !== "browse" &&
    mobileInteractionMode === "segmented";
  const isRegionSelectionMode =
    isMobileSegmentedSelectionMode || (!isMobileViewport && selectionMode === "cross");
  const activeReaderMode: ReaderMode =
    isMobileViewport && mobileBaseMode === "select" ? "select" : "translate";
  const effectiveReaderMode = isMobileViewport ? activeReaderMode : readerMode;

  useEffect(() => {
    userZoomRef.current = userZoom;
  }, [userZoom]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 920px)");
    const updateViewportState = () => {
      setIsMobileViewport(mediaQuery.matches);
    };

    updateViewportState();
    mediaQuery.addEventListener("change", updateViewportState);

    return () => {
      mediaQuery.removeEventListener("change", updateViewportState);
    };
  }, []);

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return undefined;
    }

    const resizeObserver = new ResizeObserver(([entry]) => {
      const horizontalPadding = isMobileViewport
        ? MOBILE_PDF_PAGE_LIST_PADDING_PX * 2
        : PDF_PAGE_LIST_PADDING_PX * 2;

      setAvailableWidth(Math.max(260, entry.contentRect.width - horizontalPadding));
      setHasMeasuredAvailableWidth(true);
    });

    resizeObserver.observe(scrollElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isMobileViewport]);

  useEffect(() => {
    let cancelled = false;
    let loadedDocument: PdfDocumentProxy | undefined;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | undefined;

    setLoadState("loading");
    setErrorMessage(undefined);
    setPages([]);
    setPdfDocument(undefined);
    setBaseScale(undefined);
    setRenderPageIndexes(new Set());
    const restoredZoom = normalizeUserZoom(entry.lastZoom);

    userZoomRef.current = restoredZoom;
    setRenderZoom(restoredZoom);
    setUserZoom(restoredZoom);
    setDraftSelection(undefined);
    setQueuedCrossSelections([]);
    pageIndexesRef.current = new Map();
    textContentCacheRef.current = new Map();
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
        const detail = error instanceof Error && error.message.trim() ? ` ${error.message}` : "";
        const message = `Unable to open this local PDF record. Remove it from PDF History and import it again.${detail}`;

        setErrorMessage(message);
        onDocumentLoadError?.(entry.fingerprint, message);
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
  }, [entry.blob, entry.fingerprint, onDocumentLoadError, onSentenceSelectionChange]);

  const liveFitScale = useMemo(
    () => getFitScale(pages, availableWidth, isMobileViewport ? MOBILE_MAX_RENDER_SCALE : MAX_RENDER_SCALE),
    [availableWidth, isMobileViewport, pages],
  );

  useEffect(() => {
    if (baseScale !== undefined || pages.length === 0 || !hasMeasuredAvailableWidth) {
      return;
    }

    setBaseScale(getFitScale(
      pages,
      availableWidth,
      isMobileViewport ? MOBILE_MAX_RENDER_SCALE : MAX_RENDER_SCALE,
    ));
  }, [availableWidth, baseScale, hasMeasuredAvailableWidth, isMobileViewport, pages]);

  useEffect(() => {
    setBaseScale(undefined);
    setRenderZoom(userZoomRef.current);
  }, [isMobileViewport]);

  const fitScale = baseScale ?? liveFitScale;
  const displayScale = useMemo(() => fitScale * userZoom, [fitScale, userZoom]);
  const committedDisplayScale = useMemo(() => fitScale * renderZoom, [fitScale, renderZoom]);
  const pdfRenderScale = useMemo(
    () => Math.min(committedDisplayScale, MAX_PDF_RENDER_SCALE),
    [committedDisplayScale],
  );
  const displayScaleRatio = pdfRenderScale > 0 ? displayScale / pdfRenderScale : 1;
  const pageGap = isMobileViewport ? MOBILE_PDF_PAGE_GAP_PX : PDF_PAGE_GAP_PX;
  const pageListPadding = isMobileViewport
    ? MOBILE_PDF_PAGE_LIST_PADDING_PX
    : PDF_PAGE_LIST_PADDING_PX;
  const renderPageOverscan = isMobileViewport ? 0 : PAGE_RENDER_OVERSCAN;
  const canvasOutputScaleCap = isMobileViewport
    ? MOBILE_MAX_CANVAS_OUTPUT_SCALE
    : MAX_CANVAS_OUTPUT_SCALE;
  const pageLayout = useMemo(
    () => createPageLayout(pages, displayScale, pageListPadding, pageGap),
    [displayScale, pageGap, pageListPadding, pages],
  );
  const pageListStyle = useMemo<PdfPageListStyle>(
    () =>
      ({
        "--pdf-display-scale": displayScale,
        "--pdf-render-scale": pdfRenderScale,
        "--pdf-scale-ratio": displayScaleRatio,
      }) as PdfPageListStyle,
    [displayScale, displayScaleRatio, pdfRenderScale],
  );

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

  const queueCurrentReadingPosition = useCallback(
    (lastZoom = userZoomRef.current) => {
      const scrollElement = scrollRef.current;

      if (!scrollElement) {
        return;
      }

      queueReadingPosition({
        lastPageIndex: getCurrentPageIndexFromLayout(
          pageLayout,
          scrollElement.scrollTop,
          scrollElement.clientHeight,
        ),
        lastScrollTop: scrollElement.scrollTop,
        lastZoom,
      });
    },
    [pageLayout, queueReadingPosition],
  );

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current);
      window.clearTimeout(selectionNoticeTimerRef.current);
      window.clearTimeout(realZoomCommitTimerRef.current);
      flushReadingPosition();
    };
  }, [flushReadingPosition]);

  useEffect(() => {
    queuedCrossSelectionsRef.current = queuedCrossSelections;
  }, [queuedCrossSelections]);

  useEffect(() => {
    spanDragRef.current = undefined;
    draftSelectionRef.current = undefined;
    setMobilePendingSelection(undefined);
    setConfirmedMobileReaderMode(undefined);
    setCopyNotice(undefined);
    setCopiedSelection(undefined);
    setDraftSelection(undefined);
    window.getSelection()?.removeAllRanges();
  }, [readerMode]);

  useEffect(() => {
    spanDragRef.current = undefined;
    draftSelectionRef.current = undefined;
    setMobilePendingSelection(undefined);
    setConfirmedMobileReaderMode(undefined);
    setCopyNotice(undefined);
    setCopiedSelection(undefined);
    setDraftSelection(undefined);
    if (selectionMode !== "cross") {
      queuedCrossSelectionsRef.current = [];
      setQueuedCrossSelections([]);
    }
    window.getSelection()?.removeAllRanges();
  }, [selectionMode]);

  useEffect(() => {
    if (!activeSelection) {
      setConfirmedMobileReaderMode(undefined);
    }
  }, [activeSelection]);

  useEffect(() => {
    if (!isMobileViewport) {
      return;
    }

    spanDragRef.current = undefined;
    draftSelectionRef.current = undefined;
    setMobilePendingSelection(undefined);
    setConfirmedMobileReaderMode(undefined);
    setCopyNotice(undefined);
    setCopiedSelection(undefined);
    setDraftSelection(undefined);

    if (!isMobileSegmentedSelectionMode) {
      queuedCrossSelectionsRef.current = [];
      setQueuedCrossSelections([]);
    }

    if (mobileBaseMode === "browse") {
      onSentenceSelectionChange(undefined);
    }

    window.getSelection()?.removeAllRanges();
  }, [
    isMobileSegmentedSelectionMode,
    isMobileViewport,
    mobileBaseMode,
    mobileInteractionMode,
    onSentenceSelectionChange,
  ]);

  useEffect(() => {
    return () => {
      window.clearTimeout(emphasizedPinnedCardTimerRef.current);
      window.clearTimeout(locatedPinTimerRef.current);
      window.clearTimeout(revealPinnedCardTimerRef.current);
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
      queueCurrentReadingPosition(userZoomRef.current);
    });
  }, [displayScale, queueCurrentReadingPosition]);

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (
      !scrollElement ||
      pages.length === 0 ||
      !hasMeasuredAvailableWidth ||
      restoredFingerprintRef.current === entry.fingerprint
    ) {
      return;
    }

    window.requestAnimationFrame(() => {
      if (typeof entry.lastScrollTop === "number") {
        scrollElement.scrollTop = entry.lastScrollTop;
      } else if (typeof entry.lastPageIndex === "number") {
        scrollElement.scrollTop = pageLayout.tops[entry.lastPageIndex] ?? 0;
      } else {
        scrollElement.scrollTop = 0;
      }

      restoredFingerprintRef.current = entry.fingerprint;
    });
  }, [
    entry.fingerprint,
    entry.lastPageIndex,
    entry.lastScrollTop,
    hasMeasuredAvailableWidth,
    pages.length,
    displayScale,
    pageLayout,
  ]);

  const handleScroll = useCallback(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return;
    }

    updateRenderedPageWindowFromLayout({
      pageLayout,
      overscan: renderPageOverscan,
      setRenderPageIndexes,
      viewportHeight: scrollElement.clientHeight,
      viewportTop: scrollElement.scrollTop,
    });
    queueReadingPosition({
      lastPageIndex: getCurrentPageIndexFromLayout(
        pageLayout,
        scrollElement.scrollTop,
        scrollElement.clientHeight,
      ),
      lastScrollTop: scrollElement.scrollTop,
      lastZoom: userZoomRef.current,
    });
  }, [pageLayout, queueReadingPosition, renderPageOverscan]);

  useEffect(() => {
    const scrollElement = scrollRef.current;

    if (!scrollElement || pages.length === 0) {
      return;
    }

    window.requestAnimationFrame(() => {
      updateRenderedPageWindowFromLayout({
        pageLayout,
        overscan: renderPageOverscan,
        setRenderPageIndexes,
        viewportHeight: scrollElement.clientHeight,
        viewportTop: scrollElement.scrollTop,
      });
    });
  }, [pageLayout, pages.length, renderPageOverscan]);

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
        window.clearTimeout(realZoomCommitTimerRef.current);
        realZoomCommitTimerRef.current = window.setTimeout(() => {
          setRenderZoom(nextZoom);
        }, REAL_ZOOM_COMMIT_DELAY_MS);

        return nextZoom;
      });
    },
    [],
  );

  const applyZoom = useCallback((nextZoomInput: number, anchor: { clientX: number; clientY: number }) => {
    const scrollElement = scrollRef.current;

    if (!scrollElement) {
      return;
    }

    setUserZoom((currentZoom) => {
      const nextZoom = roundPreciseZoom(clamp(nextZoomInput, USER_ZOOM_MIN, USER_ZOOM_MAX));

      if (Math.abs(nextZoom - currentZoom) < 0.005) {
        return currentZoom;
      }

      const scrollRect = scrollElement.getBoundingClientRect();
      const offsetX = anchor.clientX - scrollRect.left;
      const offsetY = anchor.clientY - scrollRect.top;

      zoomAnchorRef.current = {
        offsetX,
        offsetY,
        scaleRatio: nextZoom / currentZoom,
        scrollLeft: scrollElement.scrollLeft,
        scrollTop: scrollElement.scrollTop,
      };
      window.clearTimeout(realZoomCommitTimerRef.current);
      realZoomCommitTimerRef.current = window.setTimeout(() => {
        setRenderZoom(nextZoom);
      }, REAL_ZOOM_COMMIT_DELAY_MS);

      return nextZoom;
    });
  }, []);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const metrics = getTouchPairMetrics(event.touches);

    if (!metrics) {
      return;
    }

    pinchZoomRef.current = {
      startDistance: metrics.distance,
      startZoom: userZoom,
    };
    event.preventDefault();
  }, [userZoom]);

  const handleTouchMove = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      const pinchState = pinchZoomRef.current;
      const metrics = getTouchPairMetrics(event.touches);

      if (!pinchState || !metrics || pinchState.startDistance <= 0) {
        return;
      }

      applyZoom(pinchState.startZoom * (metrics.distance / pinchState.startDistance), {
        clientX: metrics.centerX,
        clientY: metrics.centerY,
      });
      event.preventDefault();
    },
    [applyZoom],
  );

  const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length < 2) {
      pinchZoomRef.current = undefined;
    }
  }, []);

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

  const showSelectionNotice = useCallback((message: string) => {
    setSelectionNotice(message);
    window.clearTimeout(selectionNoticeTimerRef.current);
    selectionNoticeTimerRef.current = window.setTimeout(() => {
      setSelectionNotice(undefined);
    }, 2200);
  }, []);

  const showTextOrderWarningIfNeeded = useCallback(
    (selection: SentenceSelection) => {
      const warning = getTextOrderWarning(pageIndexesRef.current.get(selection.pageIndex), selection);

      if (warning) {
        showSelectionNotice(warning);
      }
    },
    [showSelectionNotice],
  );

  const copySelectedText = useCallback(
    async (selection: SentenceSelection) => {
      setCopiedSelection(selection);

      try {
        await copyTextToClipboard(selection.targetSentence);
        setCopyNotice(t("pdf.copied"));
      } catch {
        setCopyNotice(t("pdf.copyFailed"));
      }

      window.clearTimeout(selectionNoticeTimerRef.current);
      selectionNoticeTimerRef.current = window.setTimeout(() => {
        setCopiedSelection(undefined);
        setCopyNotice(undefined);
      }, 1800);
    },
    [t],
  );

  const addPageMetricsToSelection = useCallback(
    (selection: SentenceSelection): SentenceSelection => {
      const pageDescriptor = pages.find((page) => page.pageNumber - 1 === selection.pageIndex);

      return {
        ...selection,
        cloudDocumentId: selection.cloudDocumentId ?? entry.cloudDocumentId,
        pageHeight: pageDescriptor ? pageDescriptor.height * displayScale : undefined,
        pageWidth: pageDescriptor ? pageDescriptor.width * displayScale : undefined,
      };
    },
    [displayScale, entry.cloudDocumentId, pages],
  );

  const updateDraftSelection = useCallback(
    (selection: SentenceSelection | undefined) => {
      const nextSelection = selection ? addPageMetricsToSelection(selection) : undefined;

      draftSelectionRef.current = nextSelection;
      setDraftSelection(nextSelection);
    },
    [addPageMetricsToSelection],
  );

  const addCrossSelectionPart = useCallback(
    (selection: SentenceSelection) => {
      const currentSelections = queuedCrossSelectionsRef.current;
      const existingIndex = currentSelections.findIndex((currentSelection) =>
        isSameSelectionTarget(currentSelection, selection),
      );

      if (existingIndex >= 0) {
        onSentenceSelectionChange(undefined);
        showSelectionNotice(t("pdf.regionAlreadySelected", { count: existingIndex + 1 }));
        return;
      }

      const nextSelections = [...currentSelections, selection];

      queuedCrossSelectionsRef.current = nextSelections;
      setQueuedCrossSelections(nextSelections);
      onSentenceSelectionChange(undefined);
      showSelectionNotice(t("pdf.addedRegion", { count: nextSelections.length }));
    },
    [onSentenceSelectionChange, showSelectionNotice, t],
  );

  const handleConfirmCrossSelection = useCallback(() => {
    const selection = createCompositeCrossSelection(
      queuedCrossSelections,
      entry.fingerprint,
      entry.cloudDocumentId,
    );

    if (!selection) {
      return;
    }

    queuedCrossSelectionsRef.current = [];
    setQueuedCrossSelections([]);
    if (effectiveReaderMode === "select") {
      onSentenceSelectionChange(addPageMetricsToSelection(selection));
      return;
    }

    onSentenceSelectionChange(selection);
  }, [
    addPageMetricsToSelection,
    copySelectedText,
    entry.cloudDocumentId,
    entry.fingerprint,
    onSentenceSelectionChange,
    queuedCrossSelections,
    effectiveReaderMode,
  ]);

  const handleUndoCrossSelection = useCallback(() => {
    setQueuedCrossSelections((currentSelections) => {
      const nextSelections = currentSelections.slice(0, -1);

      queuedCrossSelectionsRef.current = nextSelections;
      return nextSelections;
    });
  }, []);

  const handleClearCrossSelection = useCallback(() => {
    queuedCrossSelectionsRef.current = [];
    setQueuedCrossSelections([]);
    onSentenceSelectionChange(undefined);
  }, [onSentenceSelectionChange]);

  const handleTextPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") {
      const pointerHit = getTextSpanPointerHit(event.target, event.clientX, event.clientY);
      const shouldStartExplicitMobileSelection = isMobileSegmentedSelectionMode;

      if (!pointerHit || !shouldStartExplicitMobileSelection) {
        return;
      }

      draftSelectionRef.current = undefined;
      setDraftSelection(undefined);
      setMobilePendingSelection(undefined);
      setConfirmedMobileReaderMode(undefined);
      spanDragRef.current = {
        latestHit: pointerHit,
        pointerId: event.pointerId,
        startHit: pointerHit,
        startX: event.clientX,
        startY: event.clientY,
      };
      window.getSelection()?.removeAllRanges();
      capturePointer(event.currentTarget, event.pointerId);
      event.preventDefault();
      return;
    }

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
      capturePointer(event.currentTarget, event.pointerId);
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
    spanDragRef.current = {
      latestHit: pointerHit,
      pointerId: event.pointerId,
      startHit: pointerHit,
      startX: event.clientX,
      startY: event.clientY,
    };
    window.getSelection()?.removeAllRanges();
    capturePointer(event.currentTarget, event.pointerId);
    event.preventDefault();
  }, [
    entry.fingerprint,
    isMobileSegmentedSelectionMode,
  ]);

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

      if (isCrossPageSelection(dragState.startHit, pointerHit)) {
        showSelectionNotice(CROSS_PAGE_SELECTION_MESSAGE);
      }

      if (pointerHit && pointerHit.pageIndex === dragState.startHit.pageIndex) {
        dragState.latestHit = pointerHit;
      }

      const movedDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      const isRangeDrag =
        movedDistance >= POINTER_DRAG_THRESHOLD_PX &&
        dragState.latestHit.pageIndex === dragState.startHit.pageIndex &&
        dragState.latestHit.rawOffset !== dragState.startHit.rawOffset;

      const nextDraftSelection = isRangeDrag
        ? pointerHitRangeToWordSelection({
            contextWindowSize: settings.contextWindowN,
            endHit: dragState.latestHit,
            maxWordCount: settings.maxDraggedWords,
            pageIndexes: pageIndexesRef.current,
            pdfFingerprint: entry.fingerprint,
            startHit: dragState.startHit,
          })
        : undefined;

      updateDraftSelection(nextDraftSelection);

      event.preventDefault();
    },
    [
      entry.fingerprint,
      settings.contextWindowN,
      settings.maxDraggedWords,
      showSelectionNotice,
      updateDraftSelection,
    ],
  );

  const handleTextPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (panDragRef.current?.pointerId === event.pointerId) {
        panDragRef.current = undefined;
        setIsPanning(false);
        releasePointerCaptureIfHeld(event.currentTarget, event.pointerId);
        event.preventDefault();
        return;
      }

      const dragState = spanDragRef.current;

      if (!dragState || dragState.pointerId !== event.pointerId) {
        return;
      }

      const pointerHit = getTextSpanPointerHitFromPoint(event.clientX, event.clientY);
      if (isCrossPageSelection(dragState.startHit, pointerHit)) {
        showSelectionNotice(CROSS_PAGE_SELECTION_MESSAGE);
      }
      const endHit =
        pointerHit && pointerHit.pageIndex === dragState.startHit.pageIndex
          ? pointerHit
          : dragState.latestHit;
      const movedDistance = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);
      const isRangeDrag =
        movedDistance >= POINTER_DRAG_THRESHOLD_PX &&
        endHit.pageIndex === dragState.startHit.pageIndex &&
        endHit.rawOffset !== dragState.startHit.rawOffset;
      const shouldDeferMobileSelection =
        event.pointerType === "touch" &&
        isMobileSegmentedSelectionMode;
      const wordSelection = isRangeDrag
        ? draftSelectionRef.current ??
          (pointerHitRangeToWordSelection({
            contextWindowSize: settings.contextWindowN,
            endHit,
            maxWordCount: settings.maxDraggedWords,
            pageIndexes: pageIndexesRef.current,
            pdfFingerprint: entry.fingerprint,
            startHit: dragState.startHit,
          }) ?? undefined)
        : undefined;

      spanDragRef.current = undefined;
      window.getSelection()?.removeAllRanges();
      releasePointerCaptureIfHeld(event.currentTarget, event.pointerId);
      event.preventDefault();

      if (wordSelection) {
        const selectionWithMetrics = addPageMetricsToSelection(wordSelection);

        showTextOrderWarningIfNeeded(selectionWithMetrics);

        if (shouldDeferMobileSelection) {
          draftSelectionRef.current = selectionWithMetrics;
          setDraftSelection(selectionWithMetrics);
          setMobilePendingSelection(selectionWithMetrics);
          return;
        }

        draftSelectionRef.current = undefined;
        setDraftSelection(undefined);
        if (isRegionSelectionMode) {
          addCrossSelectionPart(selectionWithMetrics);
        } else {
          onSentenceSelectionChange(selectionWithMetrics);
        }
        return;
      }

      draftSelectionRef.current = undefined;
      setDraftSelection(undefined);
      setMobilePendingSelection(undefined);
    },
    [
      addPageMetricsToSelection,
      addCrossSelectionPart,
      entry.fingerprint,
      isMobileSegmentedSelectionMode,
      isRegionSelectionMode,
      onSentenceSelectionChange,
      settings.contextWindowN,
      settings.maxDraggedWords,
      showSelectionNotice,
      showTextOrderWarningIfNeeded,
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
      setMobilePendingSelection(undefined);
    }
  }, []);

  const handleTextIndexReady = useCallback((pageTextIndex: PageTextIndex) => {
    pageIndexesRef.current.set(pageTextIndex.pageIndex, pageTextIndex);
  }, []);

  const handleTextIndexClear = useCallback((pageIndex: number) => {
    pageIndexesRef.current.delete(pageIndex);
  }, []);

  const scrollToStoredSelection = useCallback((target: LocatableSelection) => {
    const scrollElement = scrollRef.current;

    if (!scrollElement || target.rectsOnPage.length === 0) {
      return false;
    }

    const currentPageHeight = pageLayout.heights[target.pageIndex];
    const pageScrollTop = pageLayout.tops[target.pageIndex];

    if (currentPageHeight === undefined || pageScrollTop === undefined) {
      return false;
    }

    const scaleY =
      target.pageHeight && target.pageHeight > 0 ? currentPageHeight / target.pageHeight : 1;
    const anchorTop = Math.min(...target.rectsOnPage.map((rect) => rect.top)) * scaleY;
    const targetScrollTop = Math.max(
      0,
      pageScrollTop + anchorTop - scrollElement.clientHeight * 0.24,
    );

    scrollElement.scrollTo({
      behavior: "smooth",
      top: targetScrollTop,
    });

    return true;
  }, [pageLayout]);

  const emphasizePinnedTranslationCard = useCallback((cardKey: string) => {
    setEmphasizedPinnedCardKey(cardKey);
    window.clearTimeout(emphasizedPinnedCardTimerRef.current);
    emphasizedPinnedCardTimerRef.current = window.setTimeout(() => {
      setEmphasizedPinnedCardKey((currentKey) => (currentKey === cardKey ? undefined : currentKey));
    }, 1500);
  }, []);

  const handleLocatePin = useCallback((pin: TranslationPin) => {
    if (!scrollToStoredSelection(pin)) {
      return;
    }

    setLocatedPinId(pin.id);
    window.clearTimeout(locatedPinTimerRef.current);
    locatedPinTimerRef.current = window.setTimeout(() => {
      setLocatedPinId((currentPinId) => (currentPinId === pin.id ? undefined : currentPinId));
    }, 1500);
  }, [scrollToStoredSelection]);

  const handleRevealPinnedTranslationCard = useCallback(
    (card: PinnedTranslationCard) => {
      scrollToStoredSelection(card.selection);
      onActivateTranslationCard(card.selection);
      emphasizePinnedTranslationCard(card.key);
      window.clearTimeout(revealPinnedCardTimerRef.current);
      revealPinnedCardTimerRef.current = window.setTimeout(() => {
        emphasizePinnedTranslationCard(card.key);
      }, 180);
    },
    [emphasizePinnedTranslationCard, onActivateTranslationCard, scrollToStoredSelection],
  );

  useEffect(() => {
    if (locateRequest) {
      handleLocatePin(locateRequest.pin);
    }
  }, [handleLocatePin, locateRequest]);

  useEffect(() => {
    if (!isMobileViewport) {
      setActiveMobilePinnedCardKey(undefined);
      setCollapsedMobileSelectionKey(undefined);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (
      collapsedMobileSelectionKey &&
      (!activeSelection || collapsedMobileSelectionKey !== createSelectionTargetKey(activeSelection))
    ) {
      setCollapsedMobileSelectionKey(undefined);
    }
  }, [activeSelection, collapsedMobileSelectionKey]);

  useEffect(() => {
    if (!activeMobilePinnedCardKey) {
      return;
    }

    const shouldCloseForSelection =
      Boolean(activeSelection) ||
      Boolean(draftSelection) ||
      Boolean(mobilePendingSelection);

    if (shouldCloseForSelection) {
      setActiveMobilePinnedCardKey(undefined);
      return;
    }

    if (!pinnedTranslationCards.some((card) => card.key === activeMobilePinnedCardKey)) {
      setActiveMobilePinnedCardKey(undefined);
    }
  }, [
    activeMobilePinnedCardKey,
    activeSelection,
    draftSelection,
    mobilePendingSelection,
    pinnedTranslationCards,
  ]);

  const handleCopySelection = useCallback(
    (selection: SentenceSelection) => {
      void copySelectedText(selection);
      onSentenceSelectionChange(undefined);
    },
    [copySelectedText, onSentenceSelectionChange],
  );

  const handleClearSelection = useCallback(() => {
    onSentenceSelectionChange(undefined);
  }, [onSentenceSelectionChange]);

  const handleOpenMobilePinnedCard = useCallback(
    (cardKey: string, selection: SentenceSelection) => {
      setActiveMobilePinnedCardKey(cardKey);
      onActivateTranslationCard(selection);
    },
    [onActivateTranslationCard],
  );

  const handleCollapseMobileTranslationCard = useCallback(
    (selection: SentenceSelection, isPinned: boolean) => {
      if (isPinned) {
        setActiveMobilePinnedCardKey(undefined);
        setCollapsedMobileSelectionKey(undefined);
        onSentenceSelectionChange(undefined);
        window.getSelection()?.removeAllRanges();
        return;
      }

      setCollapsedMobileSelectionKey(createSelectionTargetKey(selection));
    },
    [onSentenceSelectionChange],
  );

  const handleOpenCollapsedMobileTranslationCard = useCallback(() => {
    setCollapsedMobileSelectionKey(undefined);
  }, []);

  const handleCreateSelectAnnotation = useCallback(
    async (selection: SentenceSelection, annotation: PinAnnotationInput) => {
      await onCreateAnnotation(selection, annotation);
      showSelectionNotice(t("annotation.saved"));
      onSentenceSelectionChange(undefined);
    },
    [onCreateAnnotation, onSentenceSelectionChange, showSelectionNotice, t],
  );

  const clearMobilePendingSelection = useCallback(() => {
    draftSelectionRef.current = undefined;
    setDraftSelection(undefined);
    setMobilePendingSelection(undefined);
    setConfirmedMobileReaderMode(undefined);
    onSentenceSelectionChange(undefined);
    window.getSelection()?.removeAllRanges();
  }, [onSentenceSelectionChange]);

  const handleMobilePendingTranslate = useCallback(() => {
    if (!mobilePendingSelection) {
      return;
    }

    draftSelectionRef.current = undefined;
    setDraftSelection(undefined);
    setMobilePendingSelection(undefined);
    setConfirmedMobileReaderMode("translate");
    onSentenceSelectionChange(mobilePendingSelection);
  }, [mobilePendingSelection, onSentenceSelectionChange]);

  const handleMobilePendingCopy = useCallback(() => {
    if (!mobilePendingSelection) {
      return;
    }

    void copySelectedText(mobilePendingSelection);
    clearMobilePendingSelection();
  }, [clearMobilePendingSelection, copySelectedText, mobilePendingSelection]);

  const handleMobilePendingAddCrossSelection = useCallback(() => {
    if (!mobilePendingSelection) {
      return;
    }

    addCrossSelectionPart(mobilePendingSelection);
    draftSelectionRef.current = undefined;
    setDraftSelection(undefined);
    setMobilePendingSelection(undefined);
  }, [addCrossSelectionPart, mobilePendingSelection]);

  return (
    <div className="pdf-viewer-shell">
      <div className="pdf-viewer-header">
        <div className="pdf-viewer-heading">
          <div className="pdf-viewer-title">{entry.pdfMetadata?.title || entry.fileName}</div>
          <div className="pdf-viewer-subtitle">
            {pages.length > 0 ? t("pdf.pages", { count: pages.length }) : t("pdf.loading")}
          </div>
        </div>
        <div className="pdf-viewer-actions" aria-label={t("reader.pdfControls")}>
          {headerControls}
          <div className="pdf-zoom-toolbar" aria-label={t("pdf.zoomControls")}>
            <button
              aria-label={t("pdf.zoomOut")}
              className="icon-button icon-button--small"
              disabled={userZoom <= USER_ZOOM_MIN}
              onClick={() => handleZoom(-1)}
              title={t("pdf.zoomOut")}
              type="button"
            >
              <Minus aria-hidden="true" size={16} strokeWidth={2} />
            </button>
            <span className="pdf-zoom-value">{Math.round(userZoom * 100)}%</span>
            <button
              aria-label={t("pdf.zoomIn")}
              className="icon-button icon-button--small"
              disabled={userZoom >= USER_ZOOM_MAX}
              onClick={() => handleZoom(1)}
              title={t("pdf.zoomIn")}
              type="button"
            >
              <Plus aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
      {selectionNotice ? <div className="reader-message reader-message--inline">{selectionNotice}</div> : null}
      <div
        className={`pdf-scroll-region ${isPanning ? "pdf-scroll-region--panning" : ""} ${
          draftSelection ? "pdf-scroll-region--selecting" : ""
        } ${
          isMobileSegmentedSelectionMode
            ? "pdf-scroll-region--selection-armed"
            : ""
        }`}
        onAuxClick={handleAuxClick}
        onPointerCancel={handleTextPointerCancel}
        onPointerDown={handleTextPointerDown}
        onPointerMove={handleTextPointerMove}
        onPointerUp={handleTextPointerUp}
        onScroll={handleScroll}
        onTouchCancel={handleTouchEnd}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        ref={scrollRef}
      >
        {loadState === "error" ? (
          <div className="reader-message reader-message--actionable">
            <span>{errorMessage}</span>
            {onRemoveLocalRecord ? (
              <button
                className="reader-message-action"
                onClick={() => {
                  void Promise.resolve(onRemoveLocalRecord(entry.fingerprint)).catch(() => undefined);
                }}
                type="button"
              >
                {t("common.removeRecord")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="pdf-page-list" style={pageListStyle}>
            {pdfDocument && pages.length > 0
              ? pages.map((page) => (
                  <PdfPageView
                    activeTranslationCardZIndex={activeTranslationCardZIndex}
                    activeSelection={activeSelection}
                    canvasOutputScaleCap={canvasOutputScaleCap}
                    descriptor={page}
                    draftSelection={draftSelection}
                    key={`${entry.fingerprint}-${page.pageNumber}`}
                    onActivateTranslationCard={onActivateTranslationCard}
                    onCloseTranslationCard={onCloseTranslationCard}
                    activeMobilePinnedCardKey={activeMobilePinnedCardKey}
                    collapsedMobileSelectionKey={collapsedMobileSelectionKey}
                    emphasizedPinnedCardKey={emphasizedPinnedCardKey}
                    onClearSelection={handleClearSelection}
                    onClearQueuedSelections={handleClearCrossSelection}
                    onCollapseMobileTranslationCard={handleCollapseMobileTranslationCard}
                    onConfirmQueuedSelections={handleConfirmCrossSelection}
                    onCopySelection={handleCopySelection}
                    onCreateAnnotation={handleCreateSelectAnnotation}
                    onOpenCollapsedMobileTranslationCard={handleOpenCollapsedMobileTranslationCard}
                    onOpenMobilePinnedCard={handleOpenMobilePinnedCard}
                    onPinTranslationCard={onPinTranslationCard}
                    onPinnedTranslationRefresh={onPinnedTranslationRefresh}
                    onPinTranslation={onPinTranslation}
                    onRevealPinCard={onRevealPinCard}
                    onRevealPinnedTranslationCard={handleRevealPinnedTranslationCard}
                    onUndoQueuedSelection={handleUndoCrossSelection}
                    onPageTextReadyForPaperContext={onPageTextReadyForPaperContext}
                    onTextIndexClear={handleTextIndexClear}
                    onTextIndexReady={handleTextIndexReady}
                    onTranslationCardViewChange={onTranslationCardViewChange}
                    pdfDocument={pdfDocument}
                    pinnedTranslationCards={pinnedTranslationCards}
                    isMobileViewport={isMobileViewport}
                    paperContext={paperContext}
                    pins={pins}
                    queuedCrossSelections={queuedCrossSelections}
                    readerMode={confirmedMobileReaderMode ?? effectiveReaderMode}
                    renderScale={renderPageIndexes.has(page.pageNumber - 1) ? pdfRenderScale : 0}
                    shouldRender={renderPageIndexes.has(page.pageNumber - 1)}
                    textContentCacheRef={textContentCacheRef}
                    copyNotice={copyNotice}
                    copySelection={copiedSelection}
                    locatedPinId={locatedPinId}
                    settings={settings}
                  />
                ))
              : <div className="reader-message">{t("pdf.loadingWithDots")}</div>}
          </div>
        )}
      </div>
      {mobilePendingSelection ? (
        <div className="mobile-selection-confirm-bar" role="group" aria-label={t("pdf.selectionActions")}>
          <div className="mobile-selection-confirm-summary">
            {t("pdf.wordsSelected", { count: countWords(mobilePendingSelection.targetSentence) })}
          </div>
          <div className="mobile-selection-confirm-actions">
            {isMobileSegmentedSelectionMode ? (
              <button
                className="mobile-selection-confirm-button mobile-selection-confirm-button--primary"
                onClick={handleMobilePendingAddCrossSelection}
                type="button"
              >
                {t("common.add")}
              </button>
            ) : (
              <>
                <button
                  className="mobile-selection-confirm-button mobile-selection-confirm-button--primary"
                  onClick={handleMobilePendingTranslate}
                  type="button"
                >
                  {t("pdf.translate")}
                </button>
                <button
                  className="mobile-selection-confirm-button"
                  onClick={handleMobilePendingCopy}
                  type="button"
                >
                  {t("common.copy")}
                </button>
              </>
            )}
            <button
              className="mobile-selection-confirm-button mobile-selection-confirm-button--ghost"
              onClick={clearMobilePendingSelection}
              type="button"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : isMobileSegmentedSelectionMode && queuedCrossSelections.length > 0 ? (
        <div className="mobile-selection-confirm-bar" role="group" aria-label={t("pdf.selectionActions")}>
          <div className="mobile-selection-confirm-summary">
            {t(queuedCrossSelections.length === 1 ? "pdf.regionCount" : "pdf.regionCountPlural", {
              count: queuedCrossSelections.length,
            })}
          </div>
          <div className="mobile-selection-confirm-actions">
            <button
              className="mobile-selection-confirm-button mobile-selection-confirm-button--primary"
              onClick={handleConfirmCrossSelection}
              type="button"
            >
              {effectiveReaderMode === "select" ? t("common.confirm") : t("pdf.translate")}
            </button>
            <button
              className="mobile-selection-confirm-button"
              onClick={handleUndoCrossSelection}
              type="button"
            >
              {t("common.undo")}
            </button>
            <button
              className="mobile-selection-confirm-button mobile-selection-confirm-button--ghost"
              onClick={handleClearCrossSelection}
              type="button"
            >
              {t("common.clear")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const PdfPageView = memo(function PdfPageView({
  activeMobilePinnedCardKey,
  activeTranslationCardZIndex,
  activeSelection,
  canvasOutputScaleCap,
  descriptor,
  collapsedMobileSelectionKey,
  draftSelection,
  emphasizedPinnedCardKey,
  locatedPinId,
  isMobileViewport,
  onActivateTranslationCard,
  onCloseTranslationCard,
  onClearSelection,
  onClearQueuedSelections,
  onCollapseMobileTranslationCard,
  onConfirmQueuedSelections,
  onCopySelection,
  onCreateAnnotation,
  onOpenCollapsedMobileTranslationCard,
  onOpenMobilePinnedCard,
  onPinTranslationCard,
  onPinnedTranslationRefresh,
  onPinTranslation,
  onRevealPinCard,
  onRevealPinnedTranslationCard,
  onUndoQueuedSelection,
  onPageTextReadyForPaperContext,
  onTextIndexClear,
  onTextIndexReady,
  onTranslationCardViewChange,
  pdfDocument,
  pinnedTranslationCards,
  paperContext,
  pins,
  queuedCrossSelections,
  readerMode,
  renderScale,
  shouldRender,
  textContentCacheRef,
  copyNotice,
  copySelection,
  settings,
}: {
  activeMobilePinnedCardKey?: string;
  activeTranslationCardZIndex: number;
  activeSelection?: SentenceSelection;
  canvasOutputScaleCap: number;
  collapsedMobileSelectionKey?: string;
  descriptor: PageDescriptor;
  draftSelection?: SentenceSelection;
  emphasizedPinnedCardKey?: string;
  isMobileViewport: boolean;
  locatedPinId?: string;
  onActivateTranslationCard: (selection: SentenceSelection) => void;
  onCloseTranslationCard: (selection: SentenceSelection) => void;
  onClearSelection: () => void;
  onClearQueuedSelections: () => void;
  onCollapseMobileTranslationCard: (selection: SentenceSelection, isPinned: boolean) => void;
  onConfirmQueuedSelections: () => void;
  onCopySelection: (selection: SentenceSelection) => void;
  onCreateAnnotation: (
    selection: SentenceSelection,
    annotation: PinAnnotationInput,
  ) => Promise<void>;
  onOpenCollapsedMobileTranslationCard: () => void;
  onOpenMobilePinnedCard: (cardKey: string, selection: SentenceSelection) => void;
  onPinTranslationCard: (input: TranslationCardPinInput) => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (
    input: PinWriteInput,
    action: TranslationFavoriteAction,
  ) => Promise<void>;
  onRevealPinCard: (pin: TranslationPin) => void;
  onRevealPinnedTranslationCard: (card: PinnedTranslationCard) => void;
  onUndoQueuedSelection: () => void;
  onPageTextReadyForPaperContext: (pageIndex: number, text: string) => void;
  onTextIndexClear: (pageIndex: number) => void;
  onTextIndexReady: (pageTextIndex: PageTextIndex) => void;
  onTranslationCardViewChange: (
    selection: SentenceSelection,
    viewChange: TranslationCardViewChange,
    options?: TranslationCardViewChangeOptions,
  ) => void;
  pdfDocument: PdfDocumentProxy;
  pinnedTranslationCards: PinnedTranslationCard[];
  paperContext?: PaperContext;
  pins: TranslationPin[];
  queuedCrossSelections: SentenceSelection[];
  readerMode: ReaderMode;
  renderScale: number;
  shouldRender: boolean;
  textContentCacheRef: { current: Map<number, CachedPageText> };
  copyNotice?: string;
  copySelection?: SentenceSelection;
  settings: AppSettings;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageIndex = descriptor.pageNumber - 1;
  const pageStackZIndex = getTranslationCardPageZIndex({
    activeSelection,
    activeTranslationCardZIndex,
    pageIndex,
    pinnedTranslationCards,
  });
  const pageStyle = useMemo<PdfPageStyle>(
    () =>
      ({
        "--pdf-page-height": `${descriptor.height}px`,
        "--pdf-page-width": `${descriptor.width}px`,
        ...(pageStackZIndex === undefined ? undefined : { zIndex: pageStackZIndex }),
      }) as PdfPageStyle,
    [descriptor.height, descriptor.width, pageStackZIndex],
  );
  const [renderState, setRenderState] = useState<"idle" | "rendering" | "ready" | "error" | "no-text">("idle");

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: InstanceType<typeof pdfjsLib.TextLayer> | undefined;

    if (!shouldRender) {
      onTextIndexClear(descriptor.pageNumber - 1);
      setRenderState("idle");
      return undefined;
    }

    async function renderPage() {
      setRenderState("rendering");

      try {
        const page = await pdfDocument.getPage(descriptor.pageNumber);

        if (cancelled) {
          return;
        }

        const viewport = page.getViewport({ scale: renderScale });
        const canvas = canvasRef.current;
        const pageElement = pageRef.current;
        const textLayerElement = textLayerRef.current;
        const outputScale = Math.min(window.devicePixelRatio || 1, canvasOutputScaleCap);

        if (!canvas || !pageElement || !textLayerElement) {
          return;
        }

        const context = canvas.getContext("2d");

        if (!context) {
          throw new Error("Canvas is not available.");
        }

        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);

        textLayerElement.replaceChildren();
        textLayerElement.style.setProperty("--scale-factor", `${renderScale}`);

        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;

        if (cancelled) {
          return;
        }

        let cachedText = textContentCacheRef.current.get(descriptor.pageNumber);

        if (!cachedText) {
          const textContent = await page.getTextContent();
          const metadata = createPageTextMetadata(textContent);

          cachedText = {
            content: textContent,
            hasUsableText: hasUsableTextLayerText(metadata.text),
            metadata,
          };
          textContentCacheRef.current.set(descriptor.pageNumber, cachedText);
        }

        textLayer = new pdfjsLib.TextLayer({
          container: textLayerElement,
          textContentSource: cachedText.content,
          viewport,
        });
        await textLayer.render();

        if (!cancelled) {
          const pageTextIndex = createPageTextIndex({
            pageElement,
            pageIndex: descriptor.pageNumber - 1,
            textContent: cachedText.content,
            textMetadata: cachedText.metadata,
            textDivs: textLayer.textDivs,
            textLayerElement,
          });

          if (!cachedText.hasUsableText) {
            onTextIndexClear(pageTextIndex.pageIndex);
            setRenderState("no-text");
            return;
          }

          onTextIndexReady(pageTextIndex);
          onPageTextReadyForPaperContext(pageTextIndex.pageIndex, pageTextIndex.text);
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
  }, [
    descriptor.pageNumber,
    canvasOutputScaleCap,
    onPageTextReadyForPaperContext,
    onTextIndexClear,
    onTextIndexReady,
    pdfDocument,
    renderScale,
    shouldRender,
    textContentCacheRef,
  ]);

  return (
    <div
      className="pdf-page-shell"
      data-page-index={pageIndex}
      style={pageStyle}
    >
      <div
        className={`pdf-page pdf-page--${renderState}`}
        ref={pageRef}
      >
        <canvas className="pdf-page-canvas" ref={canvasRef} />
        <div className="textLayer pdf-text-layer" ref={textLayerRef} />
        {shouldRender ? (
          <PageOverlayLayer
            activeTranslationCardZIndex={activeTranslationCardZIndex}
            activeMobilePinnedCardKey={activeMobilePinnedCardKey}
            collapsedMobileSelectionKey={collapsedMobileSelectionKey}
            emphasizedPinnedCardKey={emphasizedPinnedCardKey}
            isMobileViewport={isMobileViewport}
            locatedPinId={locatedPinId}
            onActivateTranslationCard={onActivateTranslationCard}
            onCollapseMobileTranslationCard={onCollapseMobileTranslationCard}
            onCloseTranslationCard={onCloseTranslationCard}
            onClearSelection={onClearSelection}
            onClearQueuedSelections={onClearQueuedSelections}
            onConfirmQueuedSelections={onConfirmQueuedSelections}
            onCopySelection={onCopySelection}
            onCreateAnnotation={onCreateAnnotation}
            onOpenCollapsedMobileTranslationCard={onOpenCollapsedMobileTranslationCard}
            onOpenMobilePinnedCard={onOpenMobilePinnedCard}
            onPinTranslationCard={onPinTranslationCard}
            onPinnedTranslationRefresh={onPinnedTranslationRefresh}
            onPinTranslation={onPinTranslation}
            onRevealPinCard={onRevealPinCard}
            onRevealPinnedTranslationCard={onRevealPinnedTranslationCard}
            onUndoQueuedSelection={onUndoQueuedSelection}
            onTranslationCardViewChange={onTranslationCardViewChange}
            pageHeight={descriptor.height * renderScale}
            pageIndex={pageIndex}
            pageWidth={descriptor.width * renderScale}
            copyNotice={copyNotice}
            copySelection={copySelection}
            pinnedTranslationCards={pinnedTranslationCards}
            paperContext={paperContext}
            pins={pins}
            queuedSelections={queuedCrossSelections}
            readerMode={readerMode}
            draftSelection={draftSelection}
            selection={activeSelection}
            settings={settings}
          />
        ) : null}
        {renderState === "no-text" ? <div className="pdf-page-error">{OCR_UNSUPPORTED_MESSAGE}</div> : null}
        {renderState === "error" ? <div className="pdf-page-error">Page failed to render.</div> : null}
      </div>
    </div>
  );
});

function getTranslationCardPageZIndex({
  activeSelection,
  activeTranslationCardZIndex,
  pageIndex,
  pinnedTranslationCards,
}: {
  activeSelection?: SentenceSelection;
  activeTranslationCardZIndex: number;
  pageIndex: number;
  pinnedTranslationCards: PinnedTranslationCard[];
}) {
  let pageZIndex: number | undefined;

  if (hasPopoverAnchorOnPage(activeSelection, pageIndex)) {
    const activePinnedCard = pinnedTranslationCards.find((card) =>
      isSameSelectionTarget(card.selection, activeSelection),
    );

    pageZIndex = activePinnedCard?.zIndex ?? activeTranslationCardZIndex;
  }

  for (const card of pinnedTranslationCards) {
    if (!hasPopoverAnchorOnPage(card.selection, pageIndex)) {
      continue;
    }

    pageZIndex = Math.max(pageZIndex ?? 0, card.zIndex);
  }

  return pageZIndex;
}

function hasPopoverAnchorOnPage(selection: SentenceSelection | undefined, pageIndex: number) {
  return Boolean(
    selection && selection.pageIndex === pageIndex && selection.rectsOnPage.length > 0,
  );
}

function isSameSelectionTarget(
  left: SentenceSelection,
  right: SentenceSelection | undefined,
) {
  return Boolean(
    right &&
      left.pageIndex === right.pageIndex &&
      left.pdfFingerprint === right.pdfFingerprint &&
      left.normalizedSentence === right.normalizedSentence,
  );
}

function createSelectionTargetKey(selection: SentenceSelection) {
  return `${selection.pdfFingerprint}:${selection.pageIndex}:${selection.normalizedSentence}`;
}

function createCompositeCrossSelection(
  selections: SentenceSelection[],
  pdfFingerprint: string,
  cloudDocumentId?: string,
): SentenceSelection | undefined {
  if (selections.length === 0) {
    return undefined;
  }

  const targetSentence = joinCrossSelectionText(selections);
  const normalizedSentence = normalizeSentence(targetSentence);
  const firstSelection = selections[0];
  const anchorSelection = selections[selections.length - 1];
  const regions = selections.map(createSelectionRegion);

  if (normalizedSentence.length === 0) {
    return undefined;
  }

  return {
    anchorRegionIndex: regions.length - 1,
    cloudDocumentId: cloudDocumentId ?? firstSelection.cloudDocumentId,
    localContextAfter: anchorSelection.localContextAfter,
    localContextBefore: firstSelection.localContextBefore,
    normalizedSentence,
    pageHeight: anchorSelection.pageHeight,
    pageIndex: anchorSelection.pageIndex,
    pageWidth: anchorSelection.pageWidth,
    pdfFingerprint,
    rectsOnPage: anchorSelection.rectsOnPage,
    regions,
    selectedText: normalizedSentence,
    targetSentence,
    textSpan: anchorSelection.textSpan,
  };
}

function createSelectionRegion(selection: SentenceSelection): SelectionRegion {
  return {
    normalizedSentence: selection.normalizedSentence,
    pageHeight: selection.pageHeight,
    pageIndex: selection.pageIndex,
    pageWidth: selection.pageWidth,
    rectsOnPage: selection.rectsOnPage,
    selectedText: selection.selectedText,
    targetSentence: selection.targetSentence,
    textSpan: selection.textSpan,
  };
}

function joinCrossSelectionText(selections: SentenceSelection[]) {
  return selections
    .map((selection) => selection.targetSentence.trim())
    .filter((text) => text.length > 0)
    .reduce((joinedText, nextText) => {
      if (joinedText.length === 0) {
        return nextText;
      }

      if (/[-‐‑‒]\s*$/.test(joinedText) && /^[A-Za-z]/.test(nextText)) {
        return `${joinedText.replace(/[-‐‑‒]\s*$/, "")}${nextText}`;
      }

      return `${joinedText} ${nextText}`;
    }, "");
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

function getFitScale(pages: PageDescriptor[], availableWidth: number, maxRenderScale: number) {
  const widestPage = pages.reduce((width, page) => Math.max(width, page.width), 612);
  const nextScale = availableWidth / widestPage;

  return Math.min(maxRenderScale, Math.max(MIN_RENDER_SCALE, nextScale));
}

function createPageLayout(
  pages: PageDescriptor[],
  scale: number,
  pageListPadding: number,
  pageGap: number,
): PageLayout {
  const heights: number[] = [];
  const tops: number[] = [];
  let top = pageListPadding;

  for (const page of pages) {
    const height = page.height * scale;

    heights.push(height);
    tops.push(top);
    top += height + pageGap;
  }

  return { heights, tops };
}

function updateRenderedPageWindowFromLayout({
  pageLayout,
  overscan,
  setRenderPageIndexes,
  viewportHeight,
  viewportTop,
}: {
  overscan: number;
  pageLayout: PageLayout;
  setRenderPageIndexes: (updater: (currentIndexes: Set<number>) => Set<number>) => void;
  viewportHeight: number;
  viewportTop: number;
}) {
  if (pageLayout.tops.length === 0) {
    return;
  }

  const viewportBottom = viewportTop + viewportHeight;
  const maxPageIndex = pageLayout.tops.length - 1;
  const firstVisibleIndex = findFirstPageEndingAfter(pageLayout, viewportTop);
  const lastVisibleIndex = findLastPageStartingBefore(pageLayout, viewportBottom);
  const startIndex = clamp(firstVisibleIndex - overscan, 0, maxPageIndex);
  const endIndex = clamp(lastVisibleIndex + overscan, 0, maxPageIndex);
  const nextIndexes = new Set<number>();

  for (let pageIndex = startIndex; pageIndex <= endIndex; pageIndex += 1) {
    nextIndexes.add(pageIndex);
  }

  setRenderPageIndexes((currentIndexes) =>
    areSetsEqual(currentIndexes, nextIndexes) ? currentIndexes : nextIndexes,
  );
}

function getCurrentPageIndexFromLayout(
  pageLayout: PageLayout,
  viewportTop: number,
  viewportHeight: number,
) {
  if (pageLayout.tops.length === 0) {
    return 0;
  }

  return findLastPageStartingBefore(pageLayout, viewportTop + viewportHeight * 0.35);
}

function findFirstPageEndingAfter(pageLayout: PageLayout, targetTop: number) {
  let low = 0;
  let high = pageLayout.tops.length - 1;
  let result = pageLayout.tops.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const pageBottom = pageLayout.tops[middle] + pageLayout.heights[middle];

    if (pageBottom >= targetTop) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }

  return result;
}

function findLastPageStartingBefore(pageLayout: PageLayout, targetBottom: number) {
  let low = 0;
  let high = pageLayout.tops.length - 1;
  let result = 0;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);

    if (pageLayout.tops[middle] <= targetBottom) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return result;
}

function roundZoom(value: number) {
  return Math.round(value * 10) / 10;
}

function roundPreciseZoom(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeUserZoom(value: unknown) {
  const numericValue = Number(value);

  return Number.isFinite(numericValue)
    ? roundPreciseZoom(clamp(numericValue, USER_ZOOM_MIN, USER_ZOOM_MAX))
    : 1;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function getTouchPairMetrics(touches: TouchPointCollection) {
  if (touches.length < 2) {
    return undefined;
  }

  const firstTouch = touches[0];
  const secondTouch = touches[1];
  const deltaX = secondTouch.clientX - firstTouch.clientX;
  const deltaY = secondTouch.clientY - firstTouch.clientY;

  return {
    centerX: (firstTouch.clientX + secondTouch.clientX) / 2,
    centerY: (firstTouch.clientY + secondTouch.clientY) / 2,
    distance: Math.hypot(deltaX, deltaY),
  };
}

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function capturePointer(element: HTMLElement, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer may already be released when a long-press timer fires on mobile.
  }
}

function releasePointerCaptureIfHeld(element: HTMLElement, pointerId: number) {
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  } catch {
    // Some mobile browsers can drop capture during native gesture cancellation.
  }
}

function areSetsEqual(left: Set<number>, right: Set<number>) {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");

  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.setAttribute("readonly", "true");
  document.body.append(textarea);
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Copy failed.");
    }
  } finally {
    textarea.remove();
  }
}
