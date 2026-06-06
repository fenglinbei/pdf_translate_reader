import { Bookmark, Check, ChevronDown, Pin, RefreshCw, StickyNote, X, ZoomIn, ZoomOut } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider";
import type {
  AnnotationColor,
  AppSettings,
  PaperContext,
  SentenceSelection,
  SourceLanguage,
  TargetLanguage,
  TokenUsage,
  TranslationModel,
  TranslationRequest,
} from "../types/domain";
import { createTranslationCacheKey } from "./cacheKey";
import { TRANSLATION_PROMPT_VERSION } from "./defaults";
import { streamTranslation } from "./translationClient";
import { getTranslationCacheEntry, putTranslationCacheEntry } from "./translationRepository";
import { RichMathText } from "./RichMathText";
import type {
  FloatingTranslationCardView,
  TranslationCardPlacement,
  TranslationFavoriteAction,
  TranslationCardViewChange,
  TranslationCardViewChangeOptions,
} from "./floatingCardTypes";
import { putApiCallLog } from "./apiLogRepository";
import { getTranslationErrorMessage } from "./errors";

export type TranslationPinPayload = {
  annotation?: TranslationAnnotationInput;
  cacheKey?: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  model: TranslationModel;
  promptVersion: string;
  selection: SentenceSelection;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  translation: string;
};

export type TranslationAnnotationInput = {
  color: AnnotationColor;
  note?: string;
};

type TranslationPopoverProps = {
  annotationColor?: AnnotationColor;
  annotationNote?: string;
  isCardPinned?: boolean;
  isEmphasized?: boolean;
  isFavorited?: boolean;
  onActivate?: () => void;
  onAnnotationSave?: (
    payload: TranslationPinPayload,
    annotation: TranslationAnnotationInput,
  ) => Promise<void> | void;
  onCardPin?: (view: FloatingTranslationCardView) => void;
  onClose: () => void;
  onCollapse?: () => void;
  onFavorite?: (
    payload: TranslationPinPayload,
    action: TranslationFavoriteAction,
  ) => Promise<void> | void;
  onTranslationComplete?: (payload: TranslationPinPayload) => void;
  onViewChange?: (
    viewChange: TranslationCardViewChange,
    options?: TranslationCardViewChangeOptions,
  ) => void;
  pinSelection?: SentenceSelection;
  placement: TranslationCardPlacement;
  paperContext?: PaperContext;
  renderInPortal?: boolean;
  selection: SentenceSelection;
  settings: AppSettings;
  style: CSSProperties;
  view?: FloatingTranslationCardView;
  zIndex?: number;
};

type TranslationStatus = "idle" | "loading" | "streaming" | "success" | "error";
type TranslationSource = "api" | "cache";
type FavoriteStatus = "idle" | "saving" | "saved" | "error";
type AnnotationStatus = "idle" | "saving" | "saved" | "error";
type DragOffset = {
  x: number;
  y: number;
};
type DragState = {
  baseX: number;
  baseY: number;
  pointerId: number;
  startX: number;
  startY: number;
};
type PopoverSize = {
  height: number;
  width: number;
};
type ResizeState = {
  pointerId: number;
  startHeight: number;
  startWidth: number;
  startX: number;
  startY: number;
};

const POPOVER_MIN_WIDTH = 260;
const POPOVER_MAX_WIDTH = 560;
const POPOVER_MIN_HEIGHT = 220;
const POPOVER_MAX_HEIGHT = 560;
const CONTENT_SCALE_DEFAULT = 1;
const CONTENT_SCALE_MIN = 0.85;
const CONTENT_SCALE_MAX = 1.35;
const CONTENT_SCALE_STEP = 0.1;
const MOBILE_SHEET_MIN_HEIGHT = 220;
const MOBILE_SHEET_MAX_HEIGHT = 720;
const MOBILE_SHEET_Z_INDEX = 60;
const DEFAULT_ANNOTATION_COLOR: AnnotationColor = "yellow";
const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "blue", "green", "red"];

export function TranslationPopover({
  annotationColor,
  annotationNote,
  isCardPinned = false,
  isEmphasized = false,
  isFavorited = false,
  onActivate,
  onAnnotationSave,
  onCardPin,
  onClose,
  onCollapse,
  onFavorite,
  onTranslationComplete,
  onViewChange,
  pinSelection,
  placement,
  paperContext,
  renderInPortal = false,
  selection,
  settings,
  style,
  view,
  zIndex,
}: TranslationPopoverProps) {
  const { t } = useI18n();
  const popoverRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController>();
  const activeRequestRef = useRef<TranslationRequest>();
  const onFavoriteRef = useRef(onFavorite);
  const onTranslationCompleteRef = useRef(onTranslationComplete);
  const payloadSelectionRef = useRef(pinSelection ?? selection);
  const favoriteAfterTranslationRef = useRef(false);
  const [annotationDraft, setAnnotationDraft] = useState<TranslationAnnotationInput>({
    color: annotationColor ?? DEFAULT_ANNOTATION_COLOR,
    note: annotationNote ?? "",
  });
  const [annotationStatus, setAnnotationStatus] = useState<AnnotationStatus>("idle");
  const [isAnnotationEditorOpen, setIsAnnotationEditorOpen] = useState(false);
  const [status, setStatus] = useState<TranslationStatus>("idle");
  const [translation, setTranslation] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [cacheWarning, setCacheWarning] = useState<string>();
  const [usage, setUsage] = useState<TokenUsage>();
  const [translationSource, setTranslationSource] = useState<TranslationSource>();
  const [activeCacheKey, setActiveCacheKey] = useState<string>();
  const [favoriteStatus, setFavoriteStatus] = useState<FavoriteStatus>("idle");
  const [dragOffset, setDragOffset] = useState<DragOffset>({ x: 0, y: 0 });
  const [contentScale, setContentScale] = useState(CONTENT_SCALE_DEFAULT);
  const [isMobileSheet, setIsMobileSheet] = useState(false);
  const [mobileSheetHeight, setMobileSheetHeight] = useState<number>();
  const [popoverSize, setPopoverSize] = useState<PopoverSize>();
  const dragStateRef = useRef<DragState>();
  const resizeStateRef = useRef<ResizeState>();
  const selectionKey = useMemo(
    () => `${selection.pdfFingerprint}:${selection.pageIndex}:${selection.normalizedSentence}`,
    [selection.normalizedSentence, selection.pageIndex, selection.pdfFingerprint],
  );
  const createRequest = useCallback((): TranslationRequest => {
    const contextWindowN = settings.contextWindowN;

    return {
      cloudDocumentId: selection.cloudDocumentId,
      contextWindowN,
      localContextAfter: selection.localContextAfter.slice(0, contextWindowN),
      localContextBefore:
        contextWindowN === 0 ? [] : selection.localContextBefore.slice(-contextWindowN),
      longContextEnabled: settings.longContextEnabled,
      model: settings.defaultModel,
      paperContext: settings.longContextEnabled ? paperContext : undefined,
      pdfFingerprint: selection.pdfFingerprint,
      promptVersion: TRANSLATION_PROMPT_VERSION,
      sourceLang: settings.sourceLang,
      stream: true,
      targetLang: settings.targetLang,
      targetSentence: selection.targetSentence,
      textSource: selection.textSource,
      mathpixOptionsHash: selection.mathpixOptionsHash,
    };
  }, [
    selection.localContextAfter,
    selection.localContextBefore,
    selection.cloudDocumentId,
    selection.pdfFingerprint,
    selection.targetSentence,
    selection.textSource,
    selection.mathpixOptionsHash,
    paperContext,
    settings.contextWindowN,
    settings.defaultModel,
    settings.longContextEnabled,
    settings.sourceLang,
    settings.targetLang,
  ]);
  const createPinPayload = useCallback(
    (
      nextTranslation: string,
      cacheKey: string | undefined,
      request: TranslationRequest = activeRequestRef.current ?? createRequest(),
    ) => ({
      cacheKey,
      contextWindowN: request.contextWindowN,
      longContextEnabled: request.longContextEnabled,
      model: request.model,
      promptVersion: TRANSLATION_PROMPT_VERSION,
      selection: payloadSelectionRef.current,
      sourceLang: request.sourceLang,
      targetLang: request.targetLang,
      translation: nextTranslation,
    }),
    [createRequest],
  );
  const effectiveFavoriteStatus: FavoriteStatus =
    favoriteStatus === "saving" || favoriteStatus === "error"
      ? favoriteStatus
      : isFavorited
        ? "saved"
        : favoriteStatus === "saved"
          ? "idle"
          : favoriteStatus;
  const savedAnnotationNote = annotationNote ?? "";
  const savedAnnotationColor = annotationColor ?? DEFAULT_ANNOTATION_COLOR;
  const hasSavedAnnotation = Boolean(annotationNote?.trim()) || Boolean(annotationColor);
  const hasAnnotationDraftChanges =
    (annotationDraft.note ?? "").trim() !== savedAnnotationNote ||
    annotationDraft.color !== savedAnnotationColor;
  const canSaveAnnotation =
    Boolean(onAnnotationSave) &&
    status === "success" &&
    translation.trim().length > 0 &&
    annotationStatus !== "saving";

  useEffect(() => {
    onFavoriteRef.current = onFavorite;
    onTranslationCompleteRef.current = onTranslationComplete;
    payloadSelectionRef.current = pinSelection ?? selection;
  }, [onFavorite, onTranslationComplete, pinSelection, selection]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 920px)");
    const updateViewportState = () => {
      setIsMobileSheet(mediaQuery.matches);
    };

    updateViewportState();
    mediaQuery.addEventListener("change", updateViewportState);

    return () => {
      mediaQuery.removeEventListener("change", updateViewportState);
    };
  }, []);

  const saveFavoritePayload = useCallback(
    async (
      payload: TranslationPinPayload,
      action: TranslationFavoriteAction = "add",
    ) => {
      if (!onFavoriteRef.current) {
        return;
      }

      setFavoriteStatus("saving");
      try {
        await onFavoriteRef.current(payload, action);
        setFavoriteStatus(action === "add" ? "saved" : "idle");
      } catch {
        setFavoriteStatus("error");
      }
    },
    [],
  );

  const startTranslation = useCallback(
    (options: { bypassCache?: boolean } = {}) => {
      abortControllerRef.current?.abort();

      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const request = createRequest();
      const paperContextHash = request.paperContext?.contextHash;
      const cacheKey = createTranslationCacheKey({
        contextWindowN: request.contextWindowN,
        longContextEnabled: request.longContextEnabled,
        model: request.model,
        normalizedSentence: selection.normalizedSentence,
        paperContextHash,
        pdfFingerprint: request.pdfFingerprint,
        promptVersion: request.promptVersion,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        textSource: request.textSource,
        mathpixOptionsHash: request.mathpixOptionsHash,
      });

      setStatus("loading");
      setTranslation("");
      setErrorMessage(undefined);
      setCacheWarning(undefined);
      setUsage(undefined);
      setTranslationSource(undefined);
      setActiveCacheKey(cacheKey);
      setFavoriteStatus("idle");
      favoriteAfterTranslationRef.current = false;
      activeRequestRef.current = request;
      let apiRequestStartedAt: number | undefined;
      let streamedUsage: TokenUsage | undefined;

      void (async () => {
        if (!options.bypassCache) {
          const cachedEntry = await getTranslationCacheEntry(cacheKey).catch(() => undefined);

          if (abortController.signal.aborted) {
            return;
          }

          if (cachedEntry) {
            setTranslation(cachedEntry.translation);
            setUsage(cachedEntry.usage);
            setTranslationSource("cache");
            setStatus("success");
            if (favoriteAfterTranslationRef.current) {
              favoriteAfterTranslationRef.current = false;
              await saveFavoritePayload(createPinPayload(cachedEntry.translation, cacheKey, request));
            }
            return;
          }
        }

        let streamedTranslation = "";

        setTranslationSource("api");
        apiRequestStartedAt = Date.now();
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
            requestStartedAt: apiRequestStartedAt,
            status: "aborted",
            usage: streamedUsage,
          }).catch(() => undefined);
          return;
        }

        if (streamedTranslation.trim().length === 0) {
          throw new Error("Translation returned no text.");
        }

        await putApiCallLog({
          request,
          requestFinishedAt: Date.now(),
          requestStartedAt: apiRequestStartedAt,
          status: "success",
          usage: streamedUsage,
        }).catch(() => undefined);

        setStatus("success");

        if (streamedTranslation.length > 0) {
          await putTranslationCacheEntry({
            cacheKey,
            cloudDocumentId: request.cloudDocumentId,
            contextWindowN: request.contextWindowN,
            longContextEnabled: request.longContextEnabled,
            model: request.model,
            normalizedSentence: selection.normalizedSentence,
            paperContextHash,
            pdfFingerprint: request.pdfFingerprint,
            promptVersion: request.promptVersion,
            sourceLang: request.sourceLang,
            targetLang: request.targetLang,
            textSource: request.textSource,
            mathpixOptionsHash: request.mathpixOptionsHash,
            translation: streamedTranslation,
            usage: streamedUsage,
          }).catch(() => {
            setCacheWarning(t("translation.cacheSaveFailed"));
          });
          onTranslationCompleteRef.current?.(createPinPayload(streamedTranslation, cacheKey, request));
          if (favoriteAfterTranslationRef.current) {
            favoriteAfterTranslationRef.current = false;
            await saveFavoritePayload(createPinPayload(streamedTranslation, cacheKey, request));
          }
        }
      })().catch((error) => {
        const errorMessage = getTranslationErrorMessage(error);

        if (abortController.signal.aborted) {
          if (apiRequestStartedAt) {
            void putApiCallLog({
              errorMessage,
              request,
              requestFinishedAt: Date.now(),
              requestStartedAt: apiRequestStartedAt,
              status: "aborted",
              usage: streamedUsage,
            }).catch(() => undefined);
          }
          return;
        }

        setStatus("error");
        if (favoriteAfterTranslationRef.current) {
          favoriteAfterTranslationRef.current = false;
          setFavoriteStatus("error");
        }
        if (apiRequestStartedAt) {
          void putApiCallLog({
            errorMessage,
            request,
            requestFinishedAt: Date.now(),
            requestStartedAt: apiRequestStartedAt,
            status: "error",
            usage: streamedUsage,
          }).catch(() => undefined);
        }
        setErrorMessage(errorMessage);
      });
    },
    [createPinPayload, createRequest, saveFavoritePayload, selection.normalizedSentence],
  );

  useEffect(() => {
    activeRequestRef.current = undefined;
    setAnnotationDraft({
      color: annotationColor ?? DEFAULT_ANNOTATION_COLOR,
      note: annotationNote ?? "",
    });
    setAnnotationStatus("idle");
    setDragOffset(view?.dragOffset ?? { x: 0, y: 0 });
    setContentScale(normalizeContentScale(view?.contentScale));
    setIsAnnotationEditorOpen(Boolean(annotationNote?.trim()));
    setPopoverSize(view?.size);
    setFavoriteStatus("idle");
    favoriteAfterTranslationRef.current = false;
  }, [annotationColor, annotationNote, selectionKey]);

  useEffect(() => {
    if (isFavorited) {
      favoriteAfterTranslationRef.current = false;
      setFavoriteStatus("saved");
      return;
    }

    setFavoriteStatus((currentStatus) => (currentStatus === "saved" ? "idle" : currentStatus));
  }, [isFavorited, selectionKey]);

  useEffect(() => {
    startTranslation();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [selectionKey, startTranslation]);

  useEffect(() => {
    if (isAnnotationEditorOpen) {
      contentRef.current?.scrollTo({ top: 0 });
    }
  }, [isAnnotationEditorOpen]);

  const stopEvent = useCallback((event: MouseEvent | PointerEvent | TouchEvent) => {
    event.stopPropagation();
  }, []);

  const handleCardPin = useCallback(() => {
    onCardPin?.({
      dragOffset,
      contentScale,
      size: popoverSize,
    });
  }, [contentScale, dragOffset, onCardPin, popoverSize]);

  const handleContentScaleChange = useCallback(
    (direction: 1 | -1) => {
      setContentScale((currentScale) => {
        const nextScale = normalizeContentScale(currentScale + direction * CONTENT_SCALE_STEP);

        if (nextScale === currentScale) {
          return currentScale;
        }

        onViewChange?.({ contentScale: nextScale }, { committed: true });

        return nextScale;
      });
    },
    [onViewChange],
  );

  const handleFavorite = useCallback(() => {
    if (!onFavorite || favoriteStatus === "saving" || (!isFavorited && status === "error")) {
      return;
    }

    if (isFavorited) {
      favoriteAfterTranslationRef.current = false;
      void saveFavoritePayload(createPinPayload(translation, activeCacheKey), "remove");
      return;
    }

    if (status === "success" && translation.trim().length > 0) {
      void saveFavoritePayload(createPinPayload(translation, activeCacheKey));
      return;
    }

    favoriteAfterTranslationRef.current = true;
    setFavoriteStatus("saving");
  }, [
    activeCacheKey,
    createPinPayload,
    favoriteStatus,
    isFavorited,
    onFavorite,
    saveFavoritePayload,
    status,
    translation,
  ]);

  const handleAnnotationSave = useCallback(async () => {
    if (!onAnnotationSave || !canSaveAnnotation) {
      return;
    }

    setAnnotationStatus("saving");
    try {
      const annotation = {
        color: annotationDraft.color,
        note: annotationDraft.note,
      };

      await onAnnotationSave(createPinPayload(translation, activeCacheKey), annotation);
      setAnnotationDraft({
        color: annotation.color,
        note: annotation.note?.trim(),
      });
      setAnnotationStatus("saved");
      setFavoriteStatus("saved");
    } catch {
      setAnnotationStatus("error");
    }
  }, [
    activeCacheKey,
    annotationDraft.color,
    annotationDraft.note,
    canSaveAnnotation,
    createPinPayload,
    onAnnotationSave,
    translation,
  ]);

  const handleCardPinPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      handleCardPin();
    },
    [handleCardPin],
  );

  const handleCardPinKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      handleCardPin();
    },
    [handleCardPin],
  );

  const handleDragStart = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const target = event.target instanceof HTMLElement ? event.target : null;

      if (target?.closest("button")) {
        return;
      }

      dragStateRef.current = {
        baseX: dragOffset.x,
        baseY: dragOffset.y,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [dragOffset.x, dragOffset.y],
  );

  const handleDragMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;

    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    const nextDragOffset = {
      x: dragState.baseX + event.clientX - dragState.startX,
      y: dragState.baseY + event.clientY - dragState.startY,
    };

    setDragOffset(nextDragOffset);
    onViewChange?.({ dragOffset: nextDragOffset });
    event.preventDefault();
  }, [onViewChange]);

  const handleDragEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;

    if (dragState?.pointerId === event.pointerId) {
      const nextDragOffset = {
        x: dragState.baseX + event.clientX - dragState.startX,
        y: dragState.baseY + event.clientY - dragState.startY,
      };
      const hasMoved =
        nextDragOffset.x !== dragState.baseX ||
        nextDragOffset.y !== dragState.baseY;

      if (hasMoved) {
        setDragOffset(nextDragOffset);
        onViewChange?.({ dragOffset: nextDragOffset }, { committed: true });
      }
      dragStateRef.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    }
  }, [onViewChange]);

  const handleResizeStart = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const rect = popoverRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    resizeStateRef.current = {
      pointerId: event.pointerId,
      startHeight: rect.height,
      startWidth: rect.width,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }, []);

  const handleResizeMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;

    if (!resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    const nextPopoverSize = {
      height: clamp(
        resizeState.startHeight + event.clientY - resizeState.startY,
        POPOVER_MIN_HEIGHT,
        POPOVER_MAX_HEIGHT,
      ),
      width: clamp(
        resizeState.startWidth + event.clientX - resizeState.startX,
        POPOVER_MIN_WIDTH,
        POPOVER_MAX_WIDTH,
      ),
    };

    setPopoverSize(nextPopoverSize);
    onViewChange?.({ size: nextPopoverSize });
    event.preventDefault();
  }, [onViewChange]);

  const handleResizeEnd = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const resizeState = resizeStateRef.current;

    if (resizeState?.pointerId === event.pointerId) {
      const nextPopoverSize = {
        height: clamp(
          resizeState.startHeight + event.clientY - resizeState.startY,
          POPOVER_MIN_HEIGHT,
          POPOVER_MAX_HEIGHT,
        ),
        width: clamp(
          resizeState.startWidth + event.clientX - resizeState.startX,
          POPOVER_MIN_WIDTH,
          POPOVER_MAX_WIDTH,
        ),
      };
      const hasResized =
        event.clientX !== resizeState.startX ||
        event.clientY !== resizeState.startY;

      if (hasResized) {
        setPopoverSize(nextPopoverSize);
        onViewChange?.({ size: nextPopoverSize }, { committed: true });
      }
      resizeStateRef.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      event.preventDefault();
    }
  }, [onViewChange]);

  const handleMobileSheetResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!isMobileSheet) {
      return;
    }

    const rect = popoverRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    resizeStateRef.current = {
      pointerId: event.pointerId,
      startHeight: rect.height,
      startWidth: rect.width,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }, [isMobileSheet]);

  const handleMobileSheetResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;

    if (!isMobileSheet || !resizeState || resizeState.pointerId !== event.pointerId) {
      return;
    }

    setMobileSheetHeight(
      clamp(
        resizeState.startHeight + resizeState.startY - event.clientY,
        MOBILE_SHEET_MIN_HEIGHT,
        getMobileSheetMaxHeight(),
      ),
    );
    event.preventDefault();
  }, [isMobileSheet]);

  const handleMobileSheetResizeEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const resizeState = resizeStateRef.current;

    if (!isMobileSheet || resizeState?.pointerId !== event.pointerId) {
      return;
    }

    setMobileSheetHeight(
      clamp(
        resizeState.startHeight + resizeState.startY - event.clientY,
        MOBILE_SHEET_MIN_HEIGHT,
        getMobileSheetMaxHeight(),
      ),
    );
    resizeStateRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    event.preventDefault();
  }, [isMobileSheet]);

  const popoverStyle = useMemo(
    () => ({
      ...(isMobileSheet ? undefined : style),
      ...(popoverSize && !isMobileSheet
        ? {
            height: popoverSize.height,
            maxWidth: POPOVER_MAX_WIDTH,
            minWidth: POPOVER_MIN_WIDTH,
            width: popoverSize.width,
          }
        : undefined),
      ...(isMobileSheet && mobileSheetHeight ? { height: mobileSheetHeight } : undefined),
      transform: isMobileSheet ? undefined : `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      ...(isMobileSheet
        ? { zIndex: MOBILE_SHEET_Z_INDEX }
        : typeof zIndex === "number"
          ? { zIndex }
          : undefined),
    }),
    [dragOffset.x, dragOffset.y, isMobileSheet, mobileSheetHeight, popoverSize, style, zIndex],
  );

  const popover = (
    <div
      className={`translation-popover translation-popover--${placement} ${
        isMobileSheet ? "translation-popover--mobile-sheet" : ""
      } ${
        isEmphasized ? "translation-popover--emphasized" : ""
      }`}
      onFocusCapture={onActivate}
      onMouseDown={stopEvent}
      onMouseUp={stopEvent}
      onPointerDownCapture={onActivate}
      onPointerDown={stopEvent}
      onPointerUp={stopEvent}
      ref={popoverRef}
      onTouchEnd={stopEvent}
      style={popoverStyle}
    >
      {!isMobileSheet ? (
        <button
          aria-label={t("translation.resizeBox")}
          className="translation-popover-resize-hook"
          onPointerCancel={handleResizeEnd}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          title={t("translation.resize")}
          type="button"
        />
      ) : null}
      <div
        aria-hidden="true"
        className="translation-popover-drag-handle"
        onPointerCancel={isMobileSheet ? handleMobileSheetResizeEnd : handleDragEnd}
        onPointerDown={isMobileSheet ? handleMobileSheetResizeStart : handleDragStart}
        onPointerMove={isMobileSheet ? handleMobileSheetResizeMove : handleDragMove}
        onPointerUp={isMobileSheet ? handleMobileSheetResizeEnd : handleDragEnd}
        title={isMobileSheet ? t("translation.dragToResize") : t("translation.dragToMove")}
      />
      <div className="translation-popover-toolbar translation-popover-toolbar--actions-only">
        <div className="translation-popover-scale-actions">
          <button
            aria-label={t("translation.zoomOutContent")}
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            disabled={contentScale <= CONTENT_SCALE_MIN}
            onClick={() => handleContentScaleChange(-1)}
            title={t("translation.zoomOutContent")}
            type="button"
          >
            <ZoomOut aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            aria-label={t("translation.zoomInContent")}
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            disabled={contentScale >= CONTENT_SCALE_MAX}
            onClick={() => handleContentScaleChange(1)}
            title={t("translation.zoomInContent")}
            type="button"
          >
            <ZoomIn aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="translation-popover-actions">
          <button
            aria-label={isCardPinned ? t("translation.unpinCard") : t("translation.pinCard")}
            aria-pressed={isCardPinned}
            className={`icon-button icon-button--small pinned-translation-card-action translation-popover-action ${
              isCardPinned ? "icon-button--success" : ""
            }`}
            onKeyDown={handleCardPinKeyDown}
            onPointerDown={handleCardPinPointerDown}
            title={isCardPinned ? t("translation.unpin") : t("translation.pin")}
            type="button"
          >
            <Pin aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            aria-label={isFavorited ? t("translation.removeSavedAnnotation") : t("translation.saveAnnotation")}
            aria-pressed={isFavorited}
            className={`icon-button icon-button--small pinned-translation-card-action translation-popover-action ${
              effectiveFavoriteStatus === "saved"
                ? "icon-button--success"
                : effectiveFavoriteStatus === "error"
                  ? "icon-button--danger"
                  : ""
            }`}
            disabled={
              !onFavorite ||
              effectiveFavoriteStatus === "saving" ||
              (!isFavorited && status === "error")
            }
            onClick={handleFavorite}
            title={isFavorited ? t("annotation.remove") : t("translation.saveAnnotation")}
            type="button"
          >
            <Bookmark aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            aria-label={isAnnotationEditorOpen ? t("annotation.closeNoteEditor") : t("annotation.addNote")}
            aria-pressed={isAnnotationEditorOpen || hasSavedAnnotation}
            className={`icon-button icon-button--small pinned-translation-card-action translation-popover-action ${
              annotationStatus === "saved" || hasSavedAnnotation
                ? "icon-button--success"
                : annotationStatus === "error"
                  ? "icon-button--danger"
                  : ""
            }`}
            disabled={!onAnnotationSave}
            onClick={() => setIsAnnotationEditorOpen((isOpen) => !isOpen)}
            title={hasSavedAnnotation ? t("annotation.editNote") : t("annotation.addNote")}
            type="button"
          >
            <StickyNote aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            onClick={() => startTranslation({ bypassCache: true })}
            title={t("translation.retranslate")}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          {isMobileSheet && onCollapse ? (
            <button
              aria-label={t("translation.collapseCard")}
              className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
              onClick={onCollapse}
              title={t("translation.collapse")}
              type="button"
            >
              <ChevronDown aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          ) : null}
          <button
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            onClick={onClose}
            title={t("common.close")}
            type="button"
          >
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="translation-popover-content" ref={contentRef}>
        {isAnnotationEditorOpen ? (
          <div className="translation-popover-section">
            <div className="translation-popover-annotation-toolbar">
              <div className="translation-popover-label">{t("annotation.note")}</div>
              <div className="annotation-color-row" aria-label={t("annotation.color")} role="group">
                {ANNOTATION_COLORS.map((color) => (
                  <button
                    aria-label={t("annotation.colorLabel", { color: getAnnotationColorLabel(color, t) })}
                    aria-pressed={annotationDraft.color === color}
                    className={`annotation-color-swatch annotation-color-swatch--${color} ${
                      annotationDraft.color === color ? "annotation-color-swatch--active" : ""
                    }`}
                    key={color}
                    onClick={() =>
                      setAnnotationDraft((draft) => ({
                        ...draft,
                        color,
                      }))
                    }
                    title={getAnnotationColorLabel(color, t)}
                    type="button"
                  />
                ))}
              </div>
              <button
                aria-label={t("annotation.save")}
                className="icon-button icon-button--small pinned-translation-card-action"
                disabled={!canSaveAnnotation || !hasAnnotationDraftChanges}
                onClick={() => void handleAnnotationSave()}
                title={t("annotation.save")}
                type="button"
              >
                <Check aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            </div>
            <textarea
              className="translation-popover-note-input"
              onChange={(event) =>
                setAnnotationDraft((draft) => ({
                  ...draft,
                  note: event.target.value,
                }))
              }
              placeholder={t("annotation.addNote")}
              rows={3}
              value={annotationDraft.note ?? ""}
            />
          </div>
        ) : null}

        <div className="translation-popover-section">
          <div className="translation-popover-label">{t("translation.title")}</div>
          <div className={`translation-popover-output translation-popover-output--${status}`}>
            {status === "error" ? (
              errorMessage
            ) : translation ? (
              <RichMathText scale={contentScale} text={translation} />
            ) : (
              t("translation.translating")
            )}
          </div>
        </div>

        <div className="translation-popover-section">
          <div className="translation-popover-label">{t("translation.original")}</div>
          <div className="translation-popover-source">
            <RichMathText scale={contentScale} text={selection.targetSentence} />
          </div>
        </div>

        {usage || translationSource === "cache" || cacheWarning ? (
          <div className="translation-popover-meta">
            {translationSource === "cache" ? <span>{t("translation.localCache")}</span> : null}
            {translationSource === "cache" && (usage || cacheWarning) ? " · " : null}
            {usage ? (
              <span>
                {t("translation.tokens")} {usage.totalTokens ?? "-"} · {t("translation.cacheHit")} {usage.promptCacheHitTokens ?? 0}
              </span>
            ) : null}
            {usage && cacheWarning ? " · " : null}
            {cacheWarning ? <span>{cacheWarning}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  if ((isMobileSheet || renderInPortal) && typeof document !== "undefined") {
    return createPortal(popover, document.body);
  }

  return popover;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeContentScale(value: number | undefined) {
  const scale = typeof value === "number" && Number.isFinite(value)
    ? value
    : CONTENT_SCALE_DEFAULT;

  return Math.round(clamp(scale, CONTENT_SCALE_MIN, CONTENT_SCALE_MAX) * 100) / 100;
}

function getMobileSheetMaxHeight() {
  if (typeof window === "undefined") {
    return MOBILE_SHEET_MAX_HEIGHT;
  }

  return Math.min(MOBILE_SHEET_MAX_HEIGHT, Math.max(MOBILE_SHEET_MIN_HEIGHT, window.innerHeight - 24));
}

function getAnnotationColorLabel(
  color: AnnotationColor,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (color) {
    case "blue":
      return t("annotation.blue");
    case "green":
      return t("annotation.green");
    case "red":
      return t("annotation.red");
    case "yellow":
    default:
      return t("annotation.yellow");
  }
}
