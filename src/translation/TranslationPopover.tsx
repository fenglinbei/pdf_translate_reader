import { Bookmark, Pin, RefreshCw, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
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
import type {
  FloatingTranslationCardView,
  TranslationCardPlacement,
  TranslationFavoriteAction,
  TranslationCardViewChange,
} from "./floatingCardTypes";
import { putApiCallLog } from "./apiLogRepository";
import { getTranslationErrorMessage } from "./errors";

export type TranslationPinPayload = {
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

type TranslationPopoverProps = {
  isCardPinned?: boolean;
  isFavorited?: boolean;
  onActivate?: () => void;
  onCardPin?: (view: FloatingTranslationCardView) => void;
  onClose: () => void;
  onFavorite?: (
    payload: TranslationPinPayload,
    action: TranslationFavoriteAction,
  ) => Promise<void> | void;
  onTranslationComplete?: (payload: TranslationPinPayload) => void;
  onViewChange?: (viewChange: TranslationCardViewChange) => void;
  pinSelection?: SentenceSelection;
  placement: TranslationCardPlacement;
  paperContext?: PaperContext;
  selection: SentenceSelection;
  settings: AppSettings;
  style: CSSProperties;
  view?: FloatingTranslationCardView;
  zIndex?: number;
};

type TranslationStatus = "idle" | "loading" | "streaming" | "success" | "error";
type TranslationSource = "api" | "cache";
type FavoriteStatus = "idle" | "saving" | "saved" | "error";
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

export function TranslationPopover({
  isCardPinned = false,
  isFavorited = false,
  onActivate,
  onCardPin,
  onClose,
  onFavorite,
  onTranslationComplete,
  onViewChange,
  pinSelection,
  placement,
  paperContext,
  selection,
  settings,
  style,
  view,
  zIndex,
}: TranslationPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController>();
  const activeRequestRef = useRef<TranslationRequest>();
  const onFavoriteRef = useRef(onFavorite);
  const onTranslationCompleteRef = useRef(onTranslationComplete);
  const payloadSelectionRef = useRef(pinSelection ?? selection);
  const favoriteAfterTranslationRef = useRef(false);
  const [status, setStatus] = useState<TranslationStatus>("idle");
  const [translation, setTranslation] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [usage, setUsage] = useState<TokenUsage>();
  const [translationSource, setTranslationSource] = useState<TranslationSource>();
  const [activeCacheKey, setActiveCacheKey] = useState<string>();
  const [favoriteStatus, setFavoriteStatus] = useState<FavoriteStatus>("idle");
  const [dragOffset, setDragOffset] = useState<DragOffset>({ x: 0, y: 0 });
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
    };
  }, [
    selection.localContextAfter,
    selection.localContextBefore,
    selection.pdfFingerprint,
    selection.targetSentence,
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

  useEffect(() => {
    onFavoriteRef.current = onFavorite;
    onTranslationCompleteRef.current = onTranslationComplete;
    payloadSelectionRef.current = pinSelection ?? selection;
  }, [onFavorite, onTranslationComplete, pinSelection, selection]);

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
      });

      setStatus("loading");
      setTranslation("");
      setErrorMessage(undefined);
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
            contextWindowN: request.contextWindowN,
            longContextEnabled: request.longContextEnabled,
            model: request.model,
            normalizedSentence: selection.normalizedSentence,
            paperContextHash,
            pdfFingerprint: request.pdfFingerprint,
            promptVersion: request.promptVersion,
            sourceLang: request.sourceLang,
            targetLang: request.targetLang,
            translation: streamedTranslation,
            usage: streamedUsage,
          }).catch(() => undefined);
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
    setDragOffset(view?.dragOffset ?? { x: 0, y: 0 });
    setPopoverSize(view?.size);
    setFavoriteStatus("idle");
    favoriteAfterTranslationRef.current = false;
  }, [selectionKey]);

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

  const stopEvent = useCallback((event: MouseEvent | PointerEvent | TouchEvent) => {
    event.stopPropagation();
  }, []);

  const handleCardPin = useCallback(() => {
    onCardPin?.({
      dragOffset,
      size: popoverSize,
    });
  }, [dragOffset, onCardPin, popoverSize]);

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
  }, [onViewChange]);

  const handleDragEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = undefined;
    }
  }, []);

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
    if (resizeStateRef.current?.pointerId === event.pointerId) {
      resizeStateRef.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const popoverStyle = useMemo(
    () => ({
      ...style,
      ...(popoverSize
        ? {
            height: popoverSize.height,
            maxWidth: POPOVER_MAX_WIDTH,
            minWidth: POPOVER_MIN_WIDTH,
            width: popoverSize.width,
          }
        : undefined),
      transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
      ...(typeof zIndex === "number" ? { zIndex } : undefined),
    }),
    [dragOffset.x, dragOffset.y, popoverSize, style, zIndex],
  );

  return (
    <div
      className={`translation-popover translation-popover--${placement}`}
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
      <button
        aria-label="Resize translation box"
        className="translation-popover-resize-hook"
        onPointerCancel={handleResizeEnd}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        title="Resize"
        type="button"
      />
      <div
        aria-hidden="true"
        className="translation-popover-drag-handle"
        onPointerCancel={handleDragEnd}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        title="Drag to move"
      />
      <div className="translation-popover-toolbar translation-popover-toolbar--actions-only">
        <div className="translation-popover-actions">
          <button
            aria-label={isCardPinned ? "Unpin translation card" : "Pin translation card"}
            aria-pressed={isCardPinned}
            className={`icon-button icon-button--small pinned-translation-card-action translation-popover-action ${
              isCardPinned ? "icon-button--success" : ""
            }`}
            onKeyDown={handleCardPinKeyDown}
            onPointerDown={handleCardPinPointerDown}
            title={isCardPinned ? "Unpin" : "Pin"}
            type="button"
          >
            <Pin aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            aria-label={isFavorited ? "Remove favorite" : "Favorite translation"}
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
            title={isFavorited ? "Remove favorite" : "Favorite"}
            type="button"
          >
            <Bookmark aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            onClick={() => startTranslation({ bypassCache: true })}
            title="Retranslate"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small pinned-translation-card-action translation-popover-action"
            onClick={onClose}
            title="Close"
            type="button"
          >
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="translation-popover-content">
        <div className="translation-popover-section">
          <div className="translation-popover-label">Translation</div>
          <div className={`translation-popover-output translation-popover-output--${status}`}>
            {status === "error" ? errorMessage : translation || "Translating..."}
          </div>
        </div>

        <div className="translation-popover-section">
          <div className="translation-popover-label">Original</div>
          <div className="translation-popover-source">{selection.targetSentence}</div>
        </div>

        {usage || translationSource === "cache" ? (
          <div className="translation-popover-meta">
            {translationSource === "cache" ? <span>Local cache</span> : null}
            {translationSource === "cache" && usage ? " · " : null}
            {usage ? (
              <span>
                Tokens {usage.totalTokens ?? "-"} · Cache hit {usage.promptCacheHitTokens ?? 0}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
