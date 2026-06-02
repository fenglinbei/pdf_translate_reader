import { LocateFixed, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokenUsage, TranslationPin, TranslationRequest } from "../types/domain";
import { createTranslationCacheKey } from "../translation/cacheKey";
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
} from "../translation/defaults";
import { streamTranslation } from "../translation/translationClient";
import { putTranslationCacheEntry } from "../translation/translationRepository";
import { updatePinTranslation } from "./pinRepository";

type PinnedTranslationsPanelProps = {
  onLocatePin: (pin: TranslationPin) => void;
  onPinUpdated: (pin: TranslationPin) => void;
  onUnpin: (pin: TranslationPin) => void;
  pins: TranslationPin[];
};

type PinRuntimeState = {
  draftTranslation: string;
  errorMessage?: string;
  status: "loading" | "streaming" | "error";
};

export function PinnedTranslationsPanel({
  onLocatePin,
  onPinUpdated,
  onUnpin,
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

      void (async () => {
        let streamedTranslation = "";
        let streamedUsage: TokenUsage | undefined;

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
          return;
        }

        if (streamedTranslation.trim().length === 0) {
          throw new Error("Translation returned no text.");
        }

        await putTranslationCacheEntry({
          cacheKey,
          contextWindowN: request.contextWindowN,
          longContextEnabled: request.longContextEnabled,
          model: request.model,
          normalizedSentence: pin.normalizedSentence,
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
        if (abortController.signal.aborted) {
          return;
        }

        abortControllersRef.current.delete(pin.id);
        setRuntimeByPinId((state) => ({
          ...state,
          [pin.id]: {
            draftTranslation: "",
            errorMessage: error instanceof Error ? error.message : "Translation failed.",
            status: "error",
          },
        }));
      });
    },
    [onPinUpdated],
  );

  if (pins.length === 0) {
    return <div className="pins-pane-empty">No pins yet</div>;
  }

  return (
    <div className="pins-list">
      {pins.map((pin) => {
        const runtimeState = runtimeByPinId[pin.id];
        const isRetranslating =
          runtimeState?.status === "loading" || runtimeState?.status === "streaming";

        return (
          <article className="pinned-translation-card" key={pin.id}>
            <div className="pinned-translation-card-toolbar">
              <span className="pinned-translation-card-model">{getModelLabel(pin.model)}</span>
              <span className="pinned-translation-card-page">Page {pin.pageIndex + 1}</span>
              <div className="pinned-translation-card-actions">
                <button
                  aria-label="Locate original"
                  className="icon-button icon-button--small"
                  onClick={() => onLocatePin(pin)}
                  title="Locate original"
                  type="button"
                >
                  <LocateFixed aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Retranslate pinned text"
                  className="icon-button icon-button--small"
                  disabled={isRetranslating}
                  onClick={() => handleRetranslate(pin)}
                  title="Retranslate"
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Unpin translation"
                  className="icon-button icon-button--small"
                  onClick={() => onUnpin(pin)}
                  title="Unpin"
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
