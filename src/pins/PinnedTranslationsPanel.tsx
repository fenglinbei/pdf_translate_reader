import { Highlighter, LocateFixed, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaperContext, TokenUsage, TranslationPin, TranslationRequest } from "../types/domain";
import { createTranslationCacheKey } from "../translation/cacheKey";
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
} from "../translation/defaults";
import { streamTranslation } from "../translation/translationClient";
import { putTranslationCacheEntry } from "../translation/translationRepository";
import { updatePinTranslation } from "./pinRepository";
import { putApiCallLog } from "../translation/apiLogRepository";
import { getTranslationErrorMessage } from "../translation/errors";

type PinnedTranslationsPanelProps = {
  onHighlightPin: (pin: TranslationPin, highlighted: boolean) => void;
  onLocatePin: (pin: TranslationPin) => void;
  onPinUpdated: (pin: TranslationPin) => void;
  onUnpin: (pin: TranslationPin) => void;
  paperContext?: PaperContext;
  pins: TranslationPin[];
};

type PinRuntimeState = {
  draftTranslation: string;
  errorMessage?: string;
  status: "loading" | "streaming" | "error";
};

export function PinnedTranslationsPanel({
  onHighlightPin,
  onLocatePin,
  onPinUpdated,
  onUnpin,
  paperContext,
  pins,
}: PinnedTranslationsPanelProps) {
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const [runtimeByPinId, setRuntimeByPinId] = useState<Record<string, PinRuntimeState>>({});

  useEffect(() => {
    return () => {
      for (const abortController of abortControllersRef.current.values()) {
        abortController.abort();
      }
      abortControllersRef.current.clear();
    };
  }, []);

  const handleRetranslate = useCallback(
    (pin: TranslationPin) => {
      abortControllersRef.current.get(pin.id)?.abort();

      const abortController = new AbortController();
      abortControllersRef.current.set(pin.id, abortController);
      const sourceLang = pin.sourceLang ?? DEFAULT_SOURCE_LANG;
      const targetLang = pin.targetLang ?? DEFAULT_TARGET_LANG;
      const request: TranslationRequest = {
        contextWindowN: pin.contextWindowN,
        localContextAfter: pin.localContextAfter ?? [],
        localContextBefore: pin.localContextBefore ?? [],
        longContextEnabled: pin.longContextEnabled,
        model: pin.model,
        paperContext: pin.longContextEnabled ? paperContext : undefined,
        pdfFingerprint: pin.pdfFingerprint,
        promptVersion: pin.promptVersion,
        sourceLang,
        stream: true,
        targetLang,
        targetSentence: pin.targetSentence,
      };
      const cacheKey = createTranslationCacheKey({
        contextWindowN: request.contextWindowN,
        longContextEnabled: request.longContextEnabled,
        model: request.model,
        normalizedSentence: pin.normalizedSentence,
        paperContextHash: request.paperContext?.contextHash,
        pdfFingerprint: request.pdfFingerprint,
        promptVersion: request.promptVersion,
        sourceLang,
        targetLang,
      });

      setRuntimeByPinId((state) => ({
        ...state,
        [pin.id]: {
          draftTranslation: "",
          status: "loading",
        },
      }));
      let apiRequestStartedAt: number | undefined;
      let streamedUsage: TokenUsage | undefined;

      void (async () => {
        let streamedTranslation = "";
        apiRequestStartedAt = Date.now();

        await streamTranslation(
          request,
          {
            onDelta: (text) => {
              streamedTranslation += text;
              setRuntimeByPinId((state) => ({
                ...state,
                [pin.id]: {
                  draftTranslation: streamedTranslation,
                  status: "streaming",
                },
              }));
            },
            onUsage: (usage) => {
              streamedUsage = usage;
            },
          },
          abortController.signal,
        );

        if (abortController.signal.aborted) {
          if (apiRequestStartedAt) {
            await putApiCallLog({
              request,
              requestFinishedAt: Date.now(),
              requestStartedAt: apiRequestStartedAt,
              status: "aborted",
              usage: streamedUsage,
            }).catch(() => undefined);
          }
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

        await putTranslationCacheEntry({
          cacheKey,
          contextWindowN: request.contextWindowN,
          longContextEnabled: request.longContextEnabled,
          model: request.model,
          normalizedSentence: pin.normalizedSentence,
          paperContextHash: request.paperContext?.contextHash,
          pdfFingerprint: request.pdfFingerprint,
          promptVersion: request.promptVersion,
          sourceLang,
          targetLang,
          translation: streamedTranslation,
          usage: streamedUsage,
        });

        const updatedPin = await updatePinTranslation(pin.id, {
          cacheKey,
          model: request.model,
          translation: streamedTranslation,
        });

        if (updatedPin) {
          onPinUpdated(updatedPin);
        }

        abortControllersRef.current.delete(pin.id);
        setRuntimeByPinId((state) => {
          const nextState = { ...state };
          delete nextState[pin.id];
          return nextState;
        });
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

        abortControllersRef.current.delete(pin.id);
        setRuntimeByPinId((state) => ({
          ...state,
          [pin.id]: {
            draftTranslation: "",
            errorMessage,
            status: "error",
          },
        }));
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
      });
    },
    [onPinUpdated, paperContext],
  );

  if (pins.length === 0) {
    return <div className="pins-pane-empty">No favorites yet</div>;
  }

  return (
    <div className="pins-list">
      {pins.map((pin) => {
        const runtimeState = runtimeByPinId[pin.id];
        const isRetranslating =
          runtimeState?.status === "loading" || runtimeState?.status === "streaming";
        const isHighlighted = Boolean(pin.highlighted);

        return (
          <article className="pinned-translation-card" key={pin.id}>
            <div className="pinned-translation-card-toolbar">
              <span className="pinned-translation-card-model">{getModelLabel(pin.model)}</span>
              <span className="pinned-translation-card-page">Page {pin.pageIndex + 1}</span>
              <div className="pinned-translation-card-actions">
                <button
                  aria-label={isHighlighted ? "Stop highlighting original" : "Keep original highlighted"}
                  className={`icon-button icon-button--small pinned-translation-card-action ${
                    isHighlighted ? "icon-button--success" : ""
                  }`}
                  onClick={() => onHighlightPin(pin, !isHighlighted)}
                  title={isHighlighted ? "Stop highlighting original" : "Keep original highlighted"}
                  type="button"
                >
                  <Highlighter aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Locate original"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  onClick={() => onLocatePin(pin)}
                  title="Locate original"
                  type="button"
                >
                  <LocateFixed aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Retranslate favorite text"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  disabled={isRetranslating}
                  onClick={() => handleRetranslate(pin)}
                  title="Retranslate"
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Remove favorite"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  onClick={() => onUnpin(pin)}
                  title="Remove favorite"
                  type="button"
                >
                  <X aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="pinned-translation-card-source">{pin.targetSentence}</div>
            <div className={`pinned-translation-card-output pinned-translation-card-output--${runtimeState?.status ?? "success"}`}>
              {isRetranslating
                ? runtimeState?.draftTranslation || "Retranslating..."
                : pin.translation}
            </div>
            {runtimeState?.status === "error" ? (
              <div className="pinned-translation-card-error">{runtimeState.errorMessage}</div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function getModelLabel(model: TranslationPin["model"]) {
  return model === "deepseek-v4-pro" ? "Pro" : "Flash";
}
