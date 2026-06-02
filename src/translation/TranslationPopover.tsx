import { Pin, RefreshCw, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
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
  isPinned?: boolean;
  onClose: () => void;
  onPin?: (payload: TranslationPinPayload) => Promise<void> | void;
  onTranslationComplete?: (payload: TranslationPinPayload) => void;
  pinSelection?: SentenceSelection;
  placement: "above" | "below" | "left" | "right";
  selection: SentenceSelection;
  settings: AppSettings;
  style: CSSProperties;
};

type TranslationStatus = "idle" | "loading" | "streaming" | "success" | "error";
type TranslationSource = "api" | "cache";
type PinStatus = "idle" | "saving" | "saved" | "error";
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
  isPinned = false,
  onClose,
  onPin,
  onTranslationComplete,
  pinSelection,
  placement,
  selection,
  settings,
  style,
}: TranslationPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController>();
  const activeRequestRef = useRef<TranslationRequest>();
  const onPinRef = useRef(onPin);
  const onTranslationCompleteRef = useRef(onTranslationComplete);
  const payloadSelectionRef = useRef(pinSelection ?? selection);
  const pinAfterTranslationRef = useRef(false);
  const [status, setStatus] = useState<TranslationStatus>("idle");
  const [translation, setTranslation] = useState("");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [usage, setUsage] = useState<TokenUsage>();
  const [translationSource, setTranslationSource] = useState<TranslationSource>();
  const [activeCacheKey, setActiveCacheKey] = useState<string>();
  const [pinStatus, setPinStatus] = useState<PinStatus>("idle");
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
  const effectivePinStatus: PinStatus = isPinned
    ? "saved"
    : pinStatus === "saved"
      ? "idle"
      : pinStatus;

  useEffect(() => {
    onPinRef.current = onPin;
    onTranslationCompleteRef.current = onTranslationComplete;
    payloadSelectionRef.current = pinSelection ?? selection;
  }, [onPin, onTranslationComplete, pinSelection, selection]);

  const savePinPayload = useCallback(async (payload: TranslationPinPayload) => {
    if (!onPinRef.current) {
      return;
    }

    setPinStatus("saving");
    try {
      await onPinRef.current(payload);
      setPinStatus("saved");
    } catch {
      setPinStatus("error");
    }
  }, []);

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
      setPinStatus("idle");
      pinAfterTranslationRef.current = false;
      activeRequestRef.current = request;

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
            if (pinAfterTranslationRef.current) {
              pinAfterTranslationRef.current = false;
              await savePinPayload(createPinPayload(cachedEntry.translation, cacheKey, request));
            }
            return;
          }
        }

        let streamedTranslation = "";
        let streamedUsage: TokenUsage | undefined;

        setTranslationSource("api");
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
          return;
        }

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
          if (pinAfterTranslationRef.current) {
            pinAfterTranslationRef.current = false;
            await savePinPayload(createPinPayload(streamedTranslation, cacheKey, request));
          }
        }
      })().catch((error) => {
        if (abortController.signal.aborted) {
          return;
        }

        setStatus("error");
        if (pinAfterTranslationRef.current) {
          pinAfterTranslationRef.current = false;
          setPinStatus("error");
        }
        setErrorMessage(error instanceof Error ? error.message : "Translation failed.");
      });
    },
    [createPinPayload, createRequest, savePinPayload, selection.normalizedSentence],
  );

  useEffect(() => {
    activeRequestRef.current = undefined;
    setDragOffset({ x: 0, y: 0 });
    setPopoverSize(undefined);
    setPinStatus("idle");
    pinAfterTranslationRef.current = false;
  }, [selectionKey]);

  useEffect(() => {
    if (isPinned) {
      pinAfterTranslationRef.current = false;
      setPinStatus("saved");
      return;
    }

    setPinStatus((currentStatus) => (currentStatus === "saved" ? "idle" : currentStatus));
  }, [isPinned, selectionKey]);

  useEffect(() => {
    startTranslation();

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [selectionKey, startTranslation]);

  const stopEvent = useCallback((event: MouseEvent | PointerEvent | TouchEvent) => {
    event.stopPropagation();
  }, []);

  const handlePin = useCallback(() => {
    if (!onPin || isPinned || pinStatus === "saving" || status === "error") {
      return;
    }

    if (status === "success" && translation.trim().length > 0) {
      void savePinPayload(createPinPayload(translation, activeCacheKey));
      return;
    }

    pinAfterTranslationRef.current = true;
    setPinStatus("saving");
  }, [activeCacheKey, createPinPayload, isPinned, onPin, pinStatus, savePinPayload, status, translation]);

  const handlePinPointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      handlePin();
    },
    [handlePin],
  );

  const handlePinKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.stopPropagation();
      event.preventDefault();
      handlePin();
    },
    [handlePin],
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

    setDragOffset({
      x: dragState.baseX + event.clientX - dragState.startX,
      y: dragState.baseY + event.clientY - dragState.startY,
    });
  }, []);

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

    setPopoverSize({
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
    });
    event.preventDefault();
  }, []);

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
    }),
    [dragOffset.x, dragOffset.y, popoverSize, style],
  );

  return (
    <div
      className={`translation-popover translation-popover--${placement}`}
      onMouseDown={stopEvent}
      onMouseUp={stopEvent}
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
          {effectivePinStatus !== "idle" ? (
            <span className={`translation-popover-pin-chip translation-popover-pin-chip--${effectivePinStatus}`}>
              {effectivePinStatus === "saving"
                ? "Saving"
                : effectivePinStatus === "saved"
                  ? "Pinned"
                  : "Failed"}
            </span>
          ) : null}
          <button
            className="icon-button icon-button--small"
            onClick={() => startTranslation({ bypassCache: true })}
            title="Retranslate"
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className={`icon-button icon-button--small ${
              effectivePinStatus === "saved"
                ? "icon-button--success"
                : effectivePinStatus === "error"
                  ? "icon-button--danger"
                  : ""
            }`}
            disabled={
              !onPin ||
              status === "error" ||
              effectivePinStatus === "saving" ||
              effectivePinStatus === "saved"
            }
            onKeyDown={handlePinKeyDown}
            onPointerDown={handlePinPointerDown}
            title={effectivePinStatus === "saved" ? "Pinned" : "Pin"}
            type="button"
          >
            <Pin aria-hidden="true" size={16} strokeWidth={2} />
          </button>
          <button
            className="icon-button icon-button--small"
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
          <div className="translation-popover-label">Original</div>
          <div className="translation-popover-source">{selection.targetSentence}</div>
        </div>

        <div className="translation-popover-section">
          <div className="translation-popover-label">Translation</div>
          <div className={`translation-popover-output translation-popover-output--${status}`}>
            {status === "error" ? errorMessage : translation || "Translating..."}
          </div>
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
