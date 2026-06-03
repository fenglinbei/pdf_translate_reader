import { Check, Highlighter, Languages, LocateFixed, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnnotationColor,
  PaperContext,
  TokenUsage,
  TranslationPin,
  TranslationRequest,
} from "../types/domain";
import { createTranslationCacheKey } from "../translation/cacheKey";
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
} from "../translation/defaults";
import { streamTranslation } from "../translation/translationClient";
import { putTranslationCacheEntry } from "../translation/translationRepository";
import {
  updatePinTranslation,
  updatePinTranslationVisibility,
  type PinAnnotationInput,
} from "./pinRepository";
import { putApiCallLog } from "../translation/apiLogRepository";
import { getTranslationErrorMessage } from "../translation/errors";

type PinnedTranslationsPanelProps = {
  onAnnotationChange: (
    pin: TranslationPin,
    annotation: PinAnnotationInput,
  ) => Promise<void> | void;
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

type AnnotationDraft = {
  color: AnnotationColor;
  note: string;
};

const ANNOTATION_COLORS: Array<{
  label: string;
  value: AnnotationColor;
}> = [
  { label: "Yellow", value: "yellow" },
  { label: "Blue", value: "blue" },
  { label: "Green", value: "green" },
  { label: "Red", value: "red" },
];

export function PinnedTranslationsPanel({
  onAnnotationChange,
  onHighlightPin,
  onLocatePin,
  onPinUpdated,
  onUnpin,
  paperContext,
  pins,
}: PinnedTranslationsPanelProps) {
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const [annotationDraftsByPinId, setAnnotationDraftsByPinId] = useState<Record<string, AnnotationDraft>>({});
  const [savingAnnotationPinIds, setSavingAnnotationPinIds] = useState<Set<string>>(() => new Set());
  const [runtimeByPinId, setRuntimeByPinId] = useState<Record<string, PinRuntimeState>>({});

  useEffect(() => {
    return () => {
      for (const abortController of abortControllersRef.current.values()) {
        abortController.abort();
      }
      abortControllersRef.current.clear();
    };
  }, []);

  const updateAnnotationDraft = useCallback(
    (pin: TranslationPin, patch: Partial<AnnotationDraft>) => {
      setAnnotationDraftsByPinId((drafts) => ({
        ...drafts,
        [pin.id]: {
          ...getAnnotationDraft(pin),
          ...drafts[pin.id],
          ...patch,
        },
      }));
    },
    [],
  );

  const handleSaveAnnotation = useCallback(
    async (pin: TranslationPin) => {
      const draft = annotationDraftsByPinId[pin.id] ?? getAnnotationDraft(pin);

      setSavingAnnotationPinIds((pinIds) => new Set(pinIds).add(pin.id));
      try {
        await onAnnotationChange(pin, {
          color: draft.color,
          note: draft.note,
        });
        setAnnotationDraftsByPinId((drafts) => ({
          ...drafts,
          [pin.id]: {
            color: draft.color,
            note: draft.note.trim(),
          },
        }));
      } catch {
        return;
      } finally {
        setSavingAnnotationPinIds((pinIds) => {
          const nextPinIds = new Set(pinIds);

          nextPinIds.delete(pin.id);
          return nextPinIds;
        });
      }
    },
    [annotationDraftsByPinId, onAnnotationChange],
  );

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
          translationVisible: true,
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

  const handleToggleTranslation = useCallback(
    (pin: TranslationPin) => {
      const hasTranslation = pin.translation.trim().length > 0;

      if (!hasTranslation) {
        handleRetranslate(pin);
        return;
      }

      const nextVisible = !getTranslationVisible(pin);

      void updatePinTranslationVisibility(pin.id, nextVisible)
        .then((updatedPin) => {
          if (updatedPin) {
            onPinUpdated(updatedPin);
          }
        })
        .catch(() => undefined);
    },
    [handleRetranslate, onPinUpdated],
  );

  if (pins.length === 0) {
    return <div className="pins-pane-empty">No annotations yet</div>;
  }

  return (
    <div className="pins-list">
      {pins.map((pin) => {
        const runtimeState = runtimeByPinId[pin.id];
        const isRetranslating =
          runtimeState?.status === "loading" || runtimeState?.status === "streaming";
        const hasTranslation = pin.translation.trim().length > 0;
        const isTranslationVisible = getTranslationVisible(pin);
        const shouldShowTranslation = isRetranslating || (hasTranslation && isTranslationVisible);
        const isHighlighted = Boolean(pin.highlighted);
        const savedAnnotationDraft = getAnnotationDraft(pin);
        const annotationDraft = annotationDraftsByPinId[pin.id] ?? savedAnnotationDraft;
        const isSavingAnnotation = savingAnnotationPinIds.has(pin.id);
        const hasAnnotationChanges =
          annotationDraft.note.trim() !== savedAnnotationDraft.note ||
          annotationDraft.color !== savedAnnotationDraft.color;

        return (
          <article className="pinned-translation-card" key={pin.id}>
            <div className="pinned-translation-card-toolbar">
              {shouldShowTranslation ? (
                <span className="pinned-translation-card-model">{getModelLabel(pin.model)}</span>
              ) : null}
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
                  aria-label="Remove annotation"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  onClick={() => onUnpin(pin)}
                  title="Remove annotation"
                  type="button"
                >
                  <X aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            <div className="pinned-translation-card-source-block">
              <div className="pinned-translation-card-source">{pin.targetSentence}</div>
              <div className="pinned-translation-card-source-actions">
                <button
                  aria-label={shouldShowTranslation ? "Hide translation" : "Show translation"}
                  aria-pressed={shouldShowTranslation}
                  className={`icon-button icon-button--small pinned-translation-card-action ${
                    shouldShowTranslation ? "icon-button--success" : ""
                  }`}
                  disabled={isRetranslating}
                  onClick={() => handleToggleTranslation(pin)}
                  title={shouldShowTranslation ? "Hide translation" : "Show translation"}
                  type="button"
                >
                  <Languages aria-hidden="true" size={16} strokeWidth={2} />
                </button>
                <button
                  aria-label="Retranslate annotation text"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  disabled={isRetranslating}
                  onClick={() => handleRetranslate(pin)}
                  title="Retranslate"
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </div>
            </div>
            {shouldShowTranslation ? (
              <div className={`pinned-translation-card-output pinned-translation-card-output--${runtimeState?.status ?? "success"}`}>
                {isRetranslating
                  ? runtimeState?.draftTranslation || "Retranslating..."
                  : pin.translation}
              </div>
            ) : null}
            {runtimeState?.status === "error" ? (
              <div className="pinned-translation-card-error">{runtimeState.errorMessage}</div>
            ) : null}
            <div className="pinned-annotation-editor">
              <div className="pinned-annotation-editor-toolbar">
                <div className="translation-popover-label">Note</div>
                <div className="annotation-color-row" aria-label="Annotation color" role="group">
                  {ANNOTATION_COLORS.map((color) => (
                    <button
                      aria-label={`${color.label} annotation color`}
                      aria-pressed={annotationDraft.color === color.value}
                      className={`annotation-color-swatch annotation-color-swatch--${color.value} ${
                        annotationDraft.color === color.value ? "annotation-color-swatch--active" : ""
                      }`}
                      key={color.value}
                      onClick={() => updateAnnotationDraft(pin, { color: color.value })}
                      title={color.label}
                      type="button"
                    />
                  ))}
                </div>
                <button
                  aria-label="Save annotation"
                  className="icon-button icon-button--small pinned-translation-card-action"
                  disabled={!hasAnnotationChanges || isSavingAnnotation}
                  onClick={() => void handleSaveAnnotation(pin)}
                  title="Save annotation"
                  type="button"
                >
                  <Check aria-hidden="true" size={16} strokeWidth={2} />
                </button>
              </div>
              <textarea
                className="pinned-annotation-note-input"
                onChange={(event) => updateAnnotationDraft(pin, { note: event.target.value })}
                placeholder="Add a note"
                rows={3}
                value={annotationDraft.note}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function getModelLabel(model: TranslationPin["model"]) {
  return model === "deepseek-v4-pro" ? "Pro" : "Flash";
}

function getAnnotationDraft(pin: TranslationPin): AnnotationDraft {
  return {
    color: pin.color ?? "yellow",
    note: pin.note ?? "",
  };
}

function getTranslationVisible(pin: TranslationPin) {
  return pin.translationVisible ?? pin.translation.trim().length > 0;
}
