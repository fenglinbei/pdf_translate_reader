import {
  ArrowDownAZ,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Highlighter,
  Languages,
  ListOrdered,
  LocateFixed,
  PencilLine,
  RefreshCw,
  Search,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
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
import { RichMathText } from "../translation/RichMathText";

type PinnedTranslationsPanelProps = {
  focusRequest?: PinPanelFocusRequest;
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

export type PinPanelFocusRequest = {
  pinId: string;
  requestId: number;
};

type PinSortMode = "updated" | "content" | "alpha";

type PinRuntimeState = {
  draftTranslation: string;
  errorMessage?: string;
  status: "loading" | "streaming" | "error";
};

type AnnotationDraft = {
  color: AnnotationColor;
  note: string;
};

const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "blue", "green", "red"];

export function PinnedTranslationsPanel({
  focusRequest,
  onAnnotationChange,
  onHighlightPin,
  onLocatePin,
  onPinUpdated,
  onUnpin,
  paperContext,
  pins,
}: PinnedTranslationsPanelProps) {
  const { t } = useI18n();
  const abortControllersRef = useRef(new Map<string, AbortController>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const focusAnimationTimerRef = useRef<number>();
  const [annotationDraftsByPinId, setAnnotationDraftsByPinId] = useState<Record<string, AnnotationDraft>>({});
  const [editingAnnotationPinIds, setEditingAnnotationPinIds] = useState<Set<string>>(() => new Set());
  const [emphasizedPinId, setEmphasizedPinId] = useState<string>();
  const [expandedSourcePinIds, setExpandedSourcePinIds] = useState<Set<string>>(() => new Set());
  const [savingAnnotationPinIds, setSavingAnnotationPinIds] = useState<Set<string>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<PinSortMode>("updated");
  const [runtimeByPinId, setRuntimeByPinId] = useState<Record<string, PinRuntimeState>>({});

  useEffect(() => {
    return () => {
      for (const abortController of abortControllersRef.current.values()) {
        abortController.abort();
      }
      abortControllersRef.current.clear();
      window.clearTimeout(focusAnimationTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setExpandedSourcePinIds((pinIds) => {
      const visiblePinIds = new Set(pins.map((pin) => pin.id));
      let hasRemovedPin = false;
      const nextPinIds = new Set<string>();

      for (const pinId of pinIds) {
        if (visiblePinIds.has(pinId)) {
          nextPinIds.add(pinId);
        } else {
          hasRemovedPin = true;
        }
      }

      return hasRemovedPin ? nextPinIds : pinIds;
    });
    setEditingAnnotationPinIds((pinIds) => {
      const visiblePinIds = new Set(pins.map((pin) => pin.id));
      let hasRemovedPin = false;
      const nextPinIds = new Set<string>();

      for (const pinId of pinIds) {
        if (visiblePinIds.has(pinId)) {
          nextPinIds.add(pinId);
        } else {
          hasRemovedPin = true;
        }
      }

      return hasRemovedPin ? nextPinIds : pinIds;
    });
  }, [pins]);

  useEffect(() => {
    if (!focusRequest) {
      return undefined;
    }

    setSearchQuery("");
    setEmphasizedPinId(undefined);

    const frame = window.requestAnimationFrame(() => {
      const card = cardRefs.current.get(focusRequest.pinId);

      card?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      window.requestAnimationFrame(() => {
        setEmphasizedPinId(focusRequest.pinId);
        window.clearTimeout(focusAnimationTimerRef.current);
        focusAnimationTimerRef.current = window.setTimeout(() => {
          setEmphasizedPinId((pinId) =>
            pinId === focusRequest.pinId ? undefined : pinId,
          );
        }, 1500);
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusRequest]);

  const visiblePins = useMemo(
    () => {
      const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
      const filteredPins = normalizedQuery
        ? pins.filter((pin) =>
            getPinSearchText(pin).toLocaleLowerCase().includes(normalizedQuery),
          )
        : pins;

      return filteredPins.slice().sort((left, right) => comparePinsBySortMode(left, right, sortMode));
    },
    [pins, searchQuery, sortMode],
  );

  const setPinCardRef = useCallback((pinId: string, node: HTMLElement | null) => {
    if (node) {
      cardRefs.current.set(pinId, node);
      return;
    }

    cardRefs.current.delete(pinId);
  }, []);

  const handleToggleSourceExpansion = useCallback((pinId: string) => {
    setExpandedSourcePinIds((pinIds) => {
      const nextPinIds = new Set(pinIds);

      if (nextPinIds.has(pinId)) {
        nextPinIds.delete(pinId);
      } else {
        nextPinIds.add(pinId);
      }

      return nextPinIds;
    });
  }, []);

  const handleToggleAnnotationEditor = useCallback((pinId: string) => {
    setEditingAnnotationPinIds((pinIds) => {
      const nextPinIds = new Set(pinIds);

      if (nextPinIds.has(pinId)) {
        nextPinIds.delete(pinId);
      } else {
        nextPinIds.add(pinId);
      }

      return nextPinIds;
    });
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
      const note = draft.note.trim();

      setSavingAnnotationPinIds((pinIds) => new Set(pinIds).add(pin.id));
      try {
        await onAnnotationChange(pin, {
          color: draft.color,
          note,
        });
        setAnnotationDraftsByPinId((drafts) => ({
          ...drafts,
          [pin.id]: {
            color: draft.color,
            note,
          },
        }));
        setEditingAnnotationPinIds((pinIds) => {
          if (!pinIds.has(pin.id)) {
            return pinIds;
          }

          const nextPinIds = new Set(pinIds);

          nextPinIds.delete(pin.id);
          return nextPinIds;
        });
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

  const handleDeleteAnnotationNote = useCallback(
    async (pin: TranslationPin) => {
      const savedAnnotationDraft = getAnnotationDraft(pin);

      setSavingAnnotationPinIds((pinIds) => new Set(pinIds).add(pin.id));
      try {
        await onAnnotationChange(pin, {
          color: savedAnnotationDraft.color,
          note: "",
        });
        setAnnotationDraftsByPinId((drafts) => ({
          ...drafts,
          [pin.id]: {
            color: savedAnnotationDraft.color,
            note: "",
          },
        }));
        setEditingAnnotationPinIds((pinIds) => {
          if (!pinIds.has(pin.id)) {
            return pinIds;
          }

          const nextPinIds = new Set(pinIds);

          nextPinIds.delete(pin.id);
          return nextPinIds;
        });
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
    [onAnnotationChange],
  );

  const handleRetranslate = useCallback(
    (pin: TranslationPin) => {
      abortControllersRef.current.get(pin.id)?.abort();

      const abortController = new AbortController();
      abortControllersRef.current.set(pin.id, abortController);
      const sourceLang = pin.sourceLang ?? DEFAULT_SOURCE_LANG;
      const targetLang = pin.targetLang ?? DEFAULT_TARGET_LANG;
      const request: TranslationRequest = {
        cloudDocumentId: pin.cloudDocumentId,
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
        textSource: pin.textSource,
        mathpixOptionsHash: pin.mathpixOptionsHash,
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
        textSource: request.textSource,
        mathpixOptionsHash: request.mathpixOptionsHash,
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
          cloudDocumentId: request.cloudDocumentId,
          contextWindowN: request.contextWindowN,
          longContextEnabled: request.longContextEnabled,
          model: request.model,
          normalizedSentence: pin.normalizedSentence,
          paperContextHash: request.paperContext?.contextHash,
          pdfFingerprint: request.pdfFingerprint,
          promptVersion: request.promptVersion,
          sourceLang,
          targetLang,
          textSource: request.textSource,
          mathpixOptionsHash: request.mathpixOptionsHash,
          translation: streamedTranslation,
          usage: streamedUsage,
        }).catch(() => undefined);

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
    return <div className="pins-pane-empty">{t("annotation.noAnnotations")}</div>;
  }

  const nextSortMode = getNextPinSortMode(sortMode);

  return (
    <div className="pins-panel">
      <div className="pins-panel-controls">
        <div className="pins-search-shell">
          <div className="pins-search-inline">
            <Search aria-hidden="true" size={15} strokeWidth={2} />
            <input
              aria-label={t("annotation.search")}
              className="pins-search-input"
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSearchQuery("");
                }
              }}
              placeholder={t("annotation.search")}
              type="search"
              value={searchQuery}
            />
            {searchQuery ? (
              <button
                aria-label={t("common.close")}
                className="icon-button icon-button--small pinned-translation-card-action"
                onClick={() => setSearchQuery("")}
                title={t("common.close")}
                type="button"
              >
                <X aria-hidden="true" size={16} strokeWidth={2} />
              </button>
            ) : null}
          </div>
        </div>
        <button
          aria-label={t("annotation.sort.switchTo", { label: getPinSortLabel(nextSortMode, t) })}
          className="icon-button icon-button--small pins-sort-button"
          onClick={() => setSortMode(nextSortMode)}
          title={t("annotation.sort.sortedBy", { label: getPinSortLabel(sortMode, t) })}
          type="button"
        >
          {sortMode === "updated" ? (
            <Clock3 aria-hidden="true" size={16} strokeWidth={2} />
          ) : sortMode === "content" ? (
            <ListOrdered aria-hidden="true" size={16} strokeWidth={2} />
          ) : (
            <ArrowDownAZ aria-hidden="true" size={16} strokeWidth={2} />
          )}
        </button>
      </div>
      {visiblePins.length === 0 ? (
        <div className="pins-pane-empty pins-pane-empty--filtered">{t("annotation.noMatches")}</div>
      ) : null}
      <div className="pins-list">
        {visiblePins.map((pin) => {
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
          const isEditingAnnotation = editingAnnotationPinIds.has(pin.id);
          const isEmphasized = emphasizedPinId === pin.id;
          const hasSavedNote = savedAnnotationDraft.note.trim().length > 0;
          const isSourceExpanded = expandedSourcePinIds.has(pin.id);
          const sourceElementId = `pinned-translation-source-${pin.id}`;
          const shouldShowSourceToggle = shouldOfferSourceToggle(pin.targetSentence);
          const hasAnnotationChanges =
            annotationDraft.note.trim() !== savedAnnotationDraft.note ||
            annotationDraft.color !== (pin.color ?? "");
          const canSaveAnnotation =
            hasAnnotationChanges &&
            !isSavingAnnotation;

          return (
            <article
              className={`pinned-translation-card ${
                isEmphasized ? "pinned-translation-card--emphasized" : ""
              }`}
              key={pin.id}
              ref={(node) => setPinCardRef(pin.id, node)}
            >
              <div className="pinned-translation-card-toolbar">
                {shouldShowTranslation ? (
                  <span className="pinned-translation-card-model">{getModelLabel(pin.model)}</span>
                ) : null}
                <span className="pinned-translation-card-page">{t("annotation.page", { page: pin.pageIndex + 1 })}</span>
                <div className="pinned-translation-card-actions">
                  <button
                    aria-label={isHighlighted ? t("annotation.stopHighlightingOriginal") : t("annotation.keepOriginalHighlighted")}
                    className={`icon-button icon-button--small pinned-translation-card-action ${
                      isHighlighted ? "icon-button--success" : ""
                    }`}
                    onClick={() => onHighlightPin(pin, !isHighlighted)}
                    title={isHighlighted ? t("annotation.stopHighlightingOriginal") : t("annotation.keepOriginalHighlighted")}
                    type="button"
                  >
                    <Highlighter aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                  <button
                    aria-label={t("annotation.locateOriginal")}
                    className="icon-button icon-button--small pinned-translation-card-action"
                    onClick={() => onLocatePin(pin)}
                    title={t("annotation.locateOriginal")}
                    type="button"
                  >
                    <LocateFixed aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                  {!hasSavedNote && !isEditingAnnotation ? (
                    <button
                      aria-label={t("annotation.addNote")}
                      aria-pressed={isEditingAnnotation}
                      className={`icon-button icon-button--small pinned-translation-card-action ${
                        isEditingAnnotation ? "icon-button--success" : ""
                      }`}
                      onClick={() => handleToggleAnnotationEditor(pin.id)}
                      title={t("annotation.addNote")}
                      type="button"
                    >
                      <StickyNote aria-hidden="true" size={16} strokeWidth={2} />
                    </button>
                  ) : null}
                  <button
                    aria-label={t("annotation.remove")}
                    className="icon-button icon-button--small pinned-translation-card-action"
                    onClick={() => onUnpin(pin)}
                    title={t("annotation.remove")}
                    type="button"
                  >
                    <X aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                </div>
              </div>
              <div className="pinned-translation-card-source-block">
                <div className="pinned-translation-card-source-row">
                  <div
                    className={`pinned-translation-card-source ${
                      shouldShowSourceToggle && !isSourceExpanded
                        ? "pinned-translation-card-source--collapsed"
                        : ""
                    }`}
                    id={sourceElementId}
                  >
                    <RichMathText text={pin.targetSentence} />
                  </div>
                  {shouldShowSourceToggle ? (
                    <button
                      aria-controls={sourceElementId}
                      aria-expanded={isSourceExpanded}
                      aria-label={isSourceExpanded ? t("annotation.collapseOriginalText") : t("annotation.expandOriginalText")}
                      className="icon-button icon-button--small pinned-translation-card-action pinned-translation-card-source-toggle"
                      onClick={() => handleToggleSourceExpansion(pin.id)}
                      title={isSourceExpanded ? t("annotation.collapseOriginal") : t("annotation.expandOriginal")}
                      type="button"
                    >
                      {isSourceExpanded ? (
                        <ChevronUp aria-hidden="true" size={16} strokeWidth={2} />
                      ) : (
                        <ChevronDown aria-hidden="true" size={16} strokeWidth={2} />
                      )}
                    </button>
                  ) : null}
                </div>
                <div className="pinned-translation-card-source-actions">
                  <button
                    aria-label={shouldShowTranslation ? t("annotation.hideTranslation") : t("annotation.showTranslation")}
                    aria-pressed={shouldShowTranslation}
                    className={`icon-button icon-button--small pinned-translation-card-action ${
                      shouldShowTranslation ? "icon-button--success" : ""
                    }`}
                    disabled={isRetranslating}
                    onClick={() => handleToggleTranslation(pin)}
                    title={shouldShowTranslation ? t("annotation.hideTranslation") : t("annotation.showTranslation")}
                    type="button"
                  >
                    <Languages aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                  <button
                    aria-label={t("annotation.retranslateText")}
                    className="icon-button icon-button--small pinned-translation-card-action"
                    disabled={isRetranslating}
                    onClick={() => handleRetranslate(pin)}
                    title={t("translation.retranslate")}
                    type="button"
                  >
                    <RefreshCw aria-hidden="true" size={16} strokeWidth={2} />
                  </button>
                </div>
              </div>
              {hasSavedNote || isEditingAnnotation ? (
                <div className={`pinned-translation-card-note ${
                  isEditingAnnotation ? "pinned-translation-card-note--editing" : ""
                }`}>
                  {isEditingAnnotation ? (
                    <>
                      <div className="pinned-annotation-editor-toolbar">
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
                              onClick={() => updateAnnotationDraft(pin, { color })}
                              title={getAnnotationColorLabel(color, t)}
                              type="button"
                            />
                          ))}
                        </div>
                        <button
                          aria-label={t("annotation.save")}
                          className="icon-button icon-button--small pinned-translation-card-action"
                          disabled={!canSaveAnnotation}
                          onClick={() => void handleSaveAnnotation(pin)}
                          title={t("annotation.save")}
                          type="button"
                        >
                          <Check aria-hidden="true" size={16} strokeWidth={2} />
                        </button>
                        <button
                          aria-label={t("annotation.closeNoteEditor")}
                          className="icon-button icon-button--small pinned-translation-card-action"
                          onClick={() => handleToggleAnnotationEditor(pin.id)}
                          title={t("annotation.closeNoteEditor")}
                          type="button"
                        >
                          <X aria-hidden="true" size={16} strokeWidth={2} />
                        </button>
                      </div>
                      <textarea
                        className="pinned-annotation-note-input"
                        onChange={(event) => updateAnnotationDraft(pin, { note: event.target.value })}
                        placeholder={t("annotation.addNote")}
                        rows={3}
                        value={annotationDraft.note}
                      />
                    </>
                  ) : (
                    <>
                      <div className="pinned-translation-card-note-header">
                        <div className="pinned-translation-card-note-label">{t("annotation.note")}</div>
                        <div className="pinned-translation-card-note-actions">
                          <button
                            aria-label={t("annotation.editNote")}
                            className="icon-button icon-button--small pinned-translation-card-action"
                            onClick={() => handleToggleAnnotationEditor(pin.id)}
                            title={t("annotation.editNote")}
                            type="button"
                          >
                            <PencilLine aria-hidden="true" size={16} strokeWidth={2} />
                          </button>
                          <button
                            aria-label={t("annotation.deleteNote")}
                            className="icon-button icon-button--small pinned-translation-card-action"
                            disabled={isSavingAnnotation}
                            onClick={() => void handleDeleteAnnotationNote(pin)}
                            title={t("annotation.deleteNote")}
                            type="button"
                          >
                            <Trash2 aria-hidden="true" size={16} strokeWidth={2} />
                          </button>
                        </div>
                      </div>
                      <div className="pinned-translation-card-note-text">
                        {savedAnnotationDraft.note}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
              {shouldShowTranslation ? (
                <div className={`pinned-translation-card-output pinned-translation-card-output--${runtimeState?.status ?? "success"}`}>
                  {isRetranslating ? (
                    runtimeState?.draftTranslation ? (
                      <RichMathText text={runtimeState.draftTranslation} />
                    ) : (
                      t("annotation.retranslating")
                    )
                  ) : (
                    <RichMathText text={pin.translation} />
                  )}
                </div>
              ) : null}
              {runtimeState?.status === "error" ? (
                <div className="pinned-translation-card-error">{runtimeState.errorMessage}</div>
              ) : null}
            </article>
          );
        })}
      </div>
      <div className="pins-pane-summary">
        {t(pins.length === 1 ? "annotation.savedSummary" : "annotation.savedSummaryPlural", {
          count: pins.length,
        })}
      </div>
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

function shouldOfferSourceToggle(source: string) {
  const trimmedSource = source.trim();

  if (trimmedSource.length > 120) {
    return true;
  }

  return (trimmedSource.match(/[.!?。！？]+/g)?.length ?? 0) > 2;
}

function comparePinsBySortMode(
  left: TranslationPin,
  right: TranslationPin,
  sortMode: PinSortMode,
) {
  switch (sortMode) {
    case "updated":
      if (left.updatedAt !== right.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      return comparePinsByContentOrder(left, right);
    case "alpha": {
      const textComparison = left.targetSentence.localeCompare(
        right.targetSentence,
        undefined,
        { sensitivity: "base" },
      );

      return textComparison || comparePinsByContentOrder(left, right);
    }
    case "content":
    default:
      return comparePinsByContentOrder(left, right);
  }
}

function getNextPinSortMode(sortMode: PinSortMode): PinSortMode {
  switch (sortMode) {
    case "updated":
      return "content";
    case "content":
      return "alpha";
    case "alpha":
    default:
      return "updated";
  }
}

function getPinSortLabel(sortMode: PinSortMode, t: ReturnType<typeof useI18n>["t"]) {
  switch (sortMode) {
    case "updated":
      return t("annotation.sort.modifiedTime");
    case "content":
      return t("annotation.sort.contentOrder");
    case "alpha":
    default:
      return t("annotation.sort.textAz");
  }
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

function comparePinsByContentOrder(left: TranslationPin, right: TranslationPin) {
  if (left.pageIndex !== right.pageIndex) {
    return left.pageIndex - right.pageIndex;
  }

  const leftPosition = getPinContentPosition(left);
  const rightPosition = getPinContentPosition(right);

  if (leftPosition !== rightPosition) {
    return leftPosition - rightPosition;
  }

  return left.id.localeCompare(right.id);
}

function getPinContentPosition(pin: TranslationPin) {
  const positions = [
    ...(pin.regions?.map((region) => region.textSpan.startGlobalChar) ?? []),
  ].filter((position) => Number.isFinite(position));

  if (positions.length > 0) {
    return Math.min(...positions);
  }

  const firstRect = pin.rectsOnPage
    .slice()
    .sort((left, right) => (left.top - right.top) || (left.left - right.left))[0];

  return firstRect ? firstRect.top * 10000 + firstRect.left : 0;
}

function getPinSearchText(pin: TranslationPin) {
  return [
    pin.targetSentence,
    pin.selectedText,
    pin.normalizedSentence,
    pin.note,
    pin.translation,
    `page ${pin.pageIndex + 1}`,
  ].filter(Boolean).join("\n");
}
