import { Bookmark, Check, Copy, Languages, Pin, RotateCcw, StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from "react";
import type { PinAnnotationInput, PinWriteInput } from "../pins/pinRepository";
import { useI18n } from "../i18n/I18nProvider";
import type {
  AnnotationColor,
  AppSettings,
  DOMRectLike,
  PaperContext,
  SelectionRegion,
  SentenceSelection,
  TranslationPin,
} from "../types/domain";
import type {
  PinnedTranslationCard,
  TranslationCardPinInput,
  TranslationFavoriteAction,
  TranslationCardViewChange,
  TranslationCardViewChangeOptions,
} from "../translation/floatingCardTypes";
import { TranslationPopover } from "../translation/TranslationPopover";
import {
  getActionPopoverPlacement,
  getPopoverPlacement,
  getSelectionBounds,
  type PageGutters,
} from "./overlayPlacement";

const DEFAULT_ANNOTATION_COLOR: AnnotationColor = "yellow";
const ANNOTATION_COLORS: AnnotationColor[] = ["yellow", "blue", "green", "red"];
const TRANSLATION_CARD_PORTAL_Z_INDEX_MIN = 20;
const TRANSLATION_CARD_PORTAL_Z_INDEX_MAX = 39;

type PageViewportRect = {
  bottom: number;
  height: number;
  left: number;
  top: number;
  width: number;
};

type PageOverlayLayerProps = {
  activeMobilePinnedCardKey?: string;
  activeTranslationCardZIndex: number;
  collapsedMobileSelectionKey?: string;
  copyNotice?: string;
  copySelection?: SentenceSelection;
  draftSelection?: SentenceSelection;
  emphasizedPinnedCardKey?: string;
  isMobileViewport: boolean;
  locatedPinId?: string;
  onActivateTranslationCard: (selection: SentenceSelection) => void;
  onCollapseMobileTranslationCard: (selection: SentenceSelection, isPinned: boolean) => void;
  onCloseTranslationCard: (selection: SentenceSelection) => void;
  onClearSelection: () => void;
  onCopySelection: (selection: SentenceSelection) => void;
  onCreateAnnotation: (
    selection: SentenceSelection,
    annotation: PinAnnotationInput,
  ) => Promise<void>;
  onPinTranslationCard: (input: TranslationCardPinInput) => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (
    input: PinWriteInput,
    action: TranslationFavoriteAction,
  ) => Promise<void>;
  onRevealPinCard: (pin: TranslationPin) => void;
  onRevealPinnedTranslationCard: (card: PinnedTranslationCard) => void;
  onOpenCollapsedMobileTranslationCard: () => void;
  onOpenMobilePinnedCard: (cardKey: string, selection: SentenceSelection) => void;
  onClearQueuedSelections: () => void;
  onConfirmQueuedSelections: () => void;
  onUndoQueuedSelection: () => void;
  onTranslationCardViewChange: (
    selection: SentenceSelection,
    viewChange: TranslationCardViewChange,
    options?: TranslationCardViewChangeOptions,
  ) => void;
  pageHeight: number;
  pageIndex: number;
  pageWidth: number;
  paperContext?: PaperContext;
  pinnedTranslationCards: PinnedTranslationCard[];
  pins: TranslationPin[];
  queuedSelections?: SentenceSelection[];
  readerMode: "select" | "translate";
  selection?: SentenceSelection;
  settings: AppSettings;
  suppressSelectionActions?: boolean;
};

export function PageOverlayLayer({
  activeMobilePinnedCardKey,
  activeTranslationCardZIndex,
  collapsedMobileSelectionKey,
  copyNotice,
  copySelection,
  draftSelection,
  emphasizedPinnedCardKey,
  isMobileViewport,
  locatedPinId,
  onActivateTranslationCard,
  onCollapseMobileTranslationCard,
  onCloseTranslationCard,
  onClearSelection,
  onCopySelection,
  onCreateAnnotation,
  onPinTranslationCard,
  onPinnedTranslationRefresh,
  onPinTranslation,
  onRevealPinCard,
  onRevealPinnedTranslationCard,
  onOpenCollapsedMobileTranslationCard,
  onOpenMobilePinnedCard,
  onClearQueuedSelections,
  onConfirmQueuedSelections,
  onUndoQueuedSelection,
  onTranslationCardViewChange,
  pageHeight,
  pageIndex,
  pageWidth,
  paperContext,
  pinnedTranslationCards,
  pins,
  queuedSelections = [],
  readerMode,
  selection,
  settings,
  suppressSelectionActions = false,
}: PageOverlayLayerProps) {
  const { t } = useI18n();
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pageGutters, setPageGutters] = useState<PageGutters>({ left: 0, right: 0 });
  const [pageViewportRect, setPageViewportRect] = useState<PageViewportRect>({
    bottom: pageHeight,
    height: pageHeight,
    left: 0,
    top: 0,
    width: pageWidth,
  });
  const selectionKey = selection
    ? `${selection.pdfFingerprint}:${selection.pageIndex}:${selection.normalizedSentence}:${
        selection.regions?.length ?? 0
      }`
    : "";
  const selectionRectSources = selection ? getSelectionRectSourcesOnPage(selection, pageIndex) : [];
  const selectionAnchorSource = selection ? getAnchorRectSourceOnPage(selection, pageIndex) : undefined;
  const hasSelection = selectionRectSources.length > 0;
  const hasCopySelection = Boolean(
    copySelection && hasSelectionOnPage(copySelection, pageIndex),
  );
  const hasDraftSelection = Boolean(
    draftSelection && hasSelectionOnPage(draftSelection, pageIndex),
  );
  const queuedSelectionRects = queuedSelections.flatMap((queuedSelection) =>
    getSelectionRectsOnPage(queuedSelection, pageIndex, pageWidth, pageHeight),
  );
  const queuedActionSelection = queuedSelections[queuedSelections.length - 1];
  const queuedActionKey = queuedActionSelection
    ? `${queuedActionSelection.pdfFingerprint}:${queuedActionSelection.pageIndex}:${
        queuedActionSelection.normalizedSentence
      }:${queuedActionSelection.regions?.length ?? 0}`
    : "";
  const queuedActionRectSource = queuedActionSelection
    ? getAnchorRectSourceOnPage(queuedActionSelection, pageIndex)
    : undefined;
  const queuedActionRects =
    !isMobileViewport && queuedActionRectSource
      ? scaleStoredRects(queuedActionRectSource, pageWidth, pageHeight)
      : [];
  const pinnedTranslationCardsOnPage = pinnedTranslationCards.filter(
    (card) =>
      hasSelectionOnPage(card.selection, pageIndex) &&
      !(selection && isSamePinTarget(card.selection, selection)),
  );
  const locatedPin = pins.find(
    (pin) => pin.id === locatedPinId && hasSelectionOnPage(pin, pageIndex),
  );
  const annotationPins = pins.filter(
    (pin) =>
      hasSelectionOnPage(pin, pageIndex) &&
      (hasAnnotation(pin) || Boolean(pin.highlighted)),
  );
  const markerTargets = getPinMarkerTargets({
    pageIndex,
    pinnedTranslationCards,
    pins,
  });
  const selectionPin = selection
    ? pins.find((pin) => isSamePinTarget(pin, selection))
    : undefined;
  const selectionPinned = Boolean(selectionPin);
  const activePinnedCard = selection
    ? pinnedTranslationCards.find((card) => isSamePinTarget(card.selection, selection))
    : undefined;
  const isActiveSelectionMobileCollapsed =
    Boolean(
      isMobileViewport &&
      selection &&
      collapsedMobileSelectionKey === createPinTargetKey(selection),
    );
  const selectionRects = selectionRectSources.flatMap((source) =>
    scaleStoredRects(source, pageWidth, pageHeight),
  );
  const selectionAnchorRects = selectionAnchorSource
    ? scaleStoredRects(selectionAnchorSource, pageWidth, pageHeight)
    : [];
  const draftRects =
    draftSelection && hasDraftSelection
      ? getSelectionRectsOnPage(draftSelection, pageIndex, pageWidth, pageHeight)
      : [];
  const copyRects =
    copySelection && hasCopySelection
      ? getSelectionRectsOnPage(copySelection, pageIndex, pageWidth, pageHeight)
      : [];
  const needsPopoverPlacement = Boolean(selectionAnchorRects.length > 0 || queuedActionRects.length > 0);
  const needsOverlayMetrics = Boolean(
    needsPopoverPlacement || pinnedTranslationCardsOnPage.length > 0,
  );

  useEffect(() => {
    if (!needsOverlayMetrics) {
      return undefined;
    }

    const overlayElement = overlayRef.current;
    const pageElement = overlayElement?.parentElement;
    const scrollElement = overlayElement?.closest<HTMLElement>(".pdf-scroll-region");

    if (!overlayElement || !pageElement || !scrollElement) {
      return undefined;
    }

    const currentPageElement = pageElement;
    const currentScrollElement = scrollElement;

    function updatePageMetrics() {
      const pageRect = currentPageElement.getBoundingClientRect();
      const scrollRect = currentScrollElement.getBoundingClientRect();

      setPageGutters({
        left: Math.max(0, pageRect.left - scrollRect.left),
        right: Math.max(0, scrollRect.right - pageRect.right),
      });
      setPageViewportRect({
        bottom: pageRect.bottom,
        height: pageRect.height,
        left: pageRect.left,
        top: pageRect.top,
        width: pageRect.width,
      });
    }

    const resizeObserver = new ResizeObserver(updatePageMetrics);

    updatePageMetrics();
    resizeObserver.observe(currentPageElement);
    resizeObserver.observe(currentScrollElement);
    currentScrollElement.addEventListener("scroll", updatePageMetrics, { passive: true });
    window.addEventListener("resize", updatePageMetrics);

    return () => {
      resizeObserver.disconnect();
      currentScrollElement.removeEventListener("scroll", updatePageMetrics);
      window.removeEventListener("resize", updatePageMetrics);
    };
  }, [
    needsOverlayMetrics,
    pageHeight,
    pageWidth,
    pinnedTranslationCardsOnPage.length,
    queuedActionKey,
    selectionKey,
  ]);

  if (
    !hasSelection &&
    !hasCopySelection &&
    !hasDraftSelection &&
    queuedSelectionRects.length === 0 &&
    pinnedTranslationCardsOnPage.length === 0 &&
    annotationPins.length === 0 &&
    markerTargets.length === 0 &&
    !locatedPin
  ) {
    return <div className="pdf-page-overlay" ref={overlayRef} />;
  }

  const popoverPlacement =
    selection && selectionAnchorRects.length > 0
      ? getPopoverPlacement(getSelectionBounds(selectionAnchorRects), {
          gutters: pageGutters,
          height: pageHeight,
          width: pageWidth,
        })
      : undefined;
  const actionPopoverPlacement =
    !suppressSelectionActions && selection && selectionAnchorRects.length > 0
      ? getActionPopoverPlacement(getSelectionBounds(selectionAnchorRects), {
          gutters: pageGutters,
          height: pageHeight,
          width: pageWidth,
        })
      : undefined;
  const queuedActionPlacement =
    !suppressSelectionActions && queuedActionRects.length > 0
      ? getActionPopoverPlacement(getSelectionBounds(queuedActionRects), {
          gutters: pageGutters,
          height: pageHeight,
          width: pageWidth,
        })
      : undefined;
  const activePopoverSelection =
    selection && (popoverPlacement || actionPopoverPlacement)
      ? hydrateSelectionForCurrentPage(selection, pageIndex, pageWidth, pageHeight)
      : undefined;
  const activeSelectionActionPlacement = suppressSelectionActions
    ? undefined
    : actionPopoverPlacement ?? popoverPlacement;
  const activeSelectionTranslationPlacement =
    activePinnedCard
      ? {
          placement: activePinnedCard.placement,
          style: activePinnedCard.style,
        }
      : popoverPlacement;
  const shouldShowActiveSelectionAction = Boolean(
    isMobileViewport &&
      activeSelectionActionPlacement &&
      !hasDraftSelection &&
      !isActiveSelectionMobileCollapsed,
  );
  const shouldShowActiveTranslationPopover = Boolean(
    (!isMobileViewport || readerMode === "translate") &&
      activeSelectionTranslationPlacement &&
      !isActiveSelectionMobileCollapsed,
  );
  const foregroundActionZIndex = activeTranslationCardZIndex + 2;
  const portalZIndexSource = [
    activeTranslationCardZIndex,
    ...pinnedTranslationCards.map((card) => card.zIndex),
  ];

  return (
    <div className="pdf-page-overlay" ref={overlayRef}>
      {annotationPins.flatMap((pin) =>
        getSelectionRectsOnPage(pin, pageIndex, pageWidth, pageHeight).map((rect, index) => (
          <div
            aria-hidden="true"
            className={`selection-highlight selection-highlight--annotation selection-highlight--annotation-${getAnnotationColor(pin)}`}
            key={`${pin.id}-highlighted-${index}`}
            style={{
              height: rect.height,
              left: rect.left,
              top: rect.top,
              width: rect.width,
            }}
          />
        )),
      )}
      {locatedPin
        ? getSelectionRectsOnPage(locatedPin, pageIndex, pageWidth, pageHeight).map((rect, index) => (
            <div
              aria-hidden="true"
              className="selection-highlight selection-highlight--located"
              key={`${locatedPin.id}-located-${index}`}
              style={{
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
              }}
            />
          ))
        : null}
      {markerTargets.map((marker) => {
        const markerRects = getSelectionRectsOnPage(marker.rectSource, pageIndex, pageWidth, pageHeight);

        return markerRects.length > 0 ? (
          <button
            aria-label={getPinMarkerLabel(marker, t)}
            className={`pin-card-marker pin-card-marker--${marker.kind} ${
              marker.kind === "annotation" ? `pin-card-marker--${marker.color}` : ""
            } ${
              marker.pin && locatedPinId === marker.pin.id ? "pin-card-marker--located" : ""
            }`}
            key={marker.key}
            onClick={(event) => {
              event.stopPropagation();
              if (marker.card) {
                if (isMobileViewport) {
                  onOpenMobilePinnedCard(marker.card.key, marker.card.selection);
                } else {
                  onRevealPinnedTranslationCard(marker.card);
                }
                return;
              }

              if (marker.pin) {
                onRevealPinCard(marker.pin);
              }
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            style={getPinMarkerStyle(markerRects, pageWidth, pageHeight)}
            title={getPinMarkerTitle(marker, t)}
            type="button"
          >
            {marker.kind === "annotation" ? (
              <StickyNote aria-hidden="true" size={15} strokeWidth={2.2} />
            ) : marker.kind === "favorite" ? (
              <Bookmark aria-hidden="true" size={15} strokeWidth={2.2} />
            ) : (
              <Pin aria-hidden="true" size={15} strokeWidth={2.2} />
            )}
          </button>
        ) : null;
      })}
      {queuedSelectionRects.map((rect, index) => (
        <div
          aria-hidden="true"
          className="selection-highlight selection-highlight--queued"
          key={`${Math.round(rect.left)}-${Math.round(rect.top)}-queued-${index}`}
          style={{
            height: rect.height,
            left: rect.left,
            top: rect.top,
            width: rect.width,
          }}
        />
      ))}
      {queuedActionPlacement ? (
        <QueuedSelectionActionPopover
          count={queuedSelections.length}
          onClear={onClearQueuedSelections}
          onConfirm={onConfirmQueuedSelections}
          onUndo={onUndoQueuedSelection}
          placement={queuedActionPlacement.placement}
          style={{
            ...queuedActionPlacement.style,
            zIndex: foregroundActionZIndex,
          }}
        />
      ) : null}
      {hasDraftSelection ? (
        <>
          {draftRects.map((rect, index) => (
            <div
              aria-hidden="true"
              className="selection-highlight selection-highlight--draft"
              key={`${Math.round(rect.left)}-${Math.round(rect.top)}-draft-${index}`}
              style={{
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
              }}
            />
          ))}
          <div className="selection-draft-badge" style={getDraftBadgeStyle(draftRects, pageWidth)}>
            {t("pdf.selectingWords", { count: countWords(draftSelection?.targetSentence ?? "") })}
          </div>
        </>
      ) : null}
      {hasCopySelection ? (
        <>
          {copyRects.map((rect, index) => (
            <div
              aria-hidden="true"
              className="selection-highlight selection-highlight--copied"
              key={`${Math.round(rect.left)}-${Math.round(rect.top)}-copied-${index}`}
              style={{
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
              }}
            />
          ))}
          {copyNotice ? (
            <div className="selection-copy-badge" style={getDraftBadgeStyle(copyRects, pageWidth)}>
              {copyNotice}
            </div>
          ) : null}
        </>
      ) : null}
      {selection && hasSelection && !hasDraftSelection
        ? selectionRects.map((rect, index) => (
            <div
              aria-hidden="true"
              className="selection-highlight"
              key={`${Math.round(rect.left)}-${Math.round(rect.top)}-${index}`}
              style={{
                height: rect.height,
                left: rect.left,
                top: rect.top,
                width: rect.width,
              }}
            />
          ))
        : null}
      {selection && hasSelection && !hasDraftSelection && isActiveSelectionMobileCollapsed ? (
        <button
          aria-label={t("translation.openCollapsed")}
          className="pinned-card-chip pinned-card-chip--transient"
          onClick={onOpenCollapsedMobileTranslationCard}
          style={getPinnedCardChipStyle(selectionRects, pageWidth, pageHeight)}
          title={t("translation.open")}
          type="button"
        >
          <Languages aria-hidden="true" size={13} strokeWidth={2.2} />
        </button>
      ) : null}
      {selection && activePopoverSelection
        ? shouldShowActiveSelectionAction && activeSelectionActionPlacement ? (
            <SelectActionPopover
              key={selectionKey}
              onClose={onClearSelection}
              onCopy={() => onCopySelection(activePopoverSelection)}
              onCreateAnnotation={(annotation) =>
                onCreateAnnotation(activePopoverSelection, annotation)
              }
              onTranslate={() => undefined}
              placement={activeSelectionActionPlacement.placement}
              selection={activePopoverSelection}
              style={{
                ...activeSelectionActionPlacement.style,
                zIndex: foregroundActionZIndex,
              }}
            />
          ) : shouldShowActiveTranslationPopover && activeSelectionTranslationPlacement ? (
            <TranslationPopover
              annotationColor={selectionPin?.color}
              annotationNote={selectionPin?.note}
              isCardPinned={Boolean(activePinnedCard)}
              isEmphasized={Boolean(activePinnedCard && activePinnedCard.key === emphasizedPinnedCardKey)}
              isFavorited={selectionPinned}
              onActivate={() => onActivateTranslationCard(selection)}
              onAnnotationSave={(payload, annotation) =>
                onPinTranslation(
                  {
                    ...payload,
                    annotation,
                    pageHeight,
                    pageWidth,
                  },
                  "add",
                )
              }
              onCardPin={(view) =>
                onPinTranslationCard({
                  placement: activeSelectionTranslationPlacement.placement,
                  selection: activePopoverSelection,
                  style: activeSelectionTranslationPlacement.style,
                  view,
                })
              }
              onCollapse={
                isMobileViewport
                  ? () => onCollapseMobileTranslationCard(selection, Boolean(activePinnedCard))
                  : undefined
              }
              onClose={() => onCloseTranslationCard(selection)}
              onFavorite={(payload, action) =>
                onPinTranslation(
                  {
                    ...payload,
                    pageHeight,
                    pageWidth,
                  },
                  action,
                )
              }
              onTranslationComplete={(payload) =>
                onPinnedTranslationRefresh({
                  ...payload,
                  pageHeight,
                  pageWidth,
                })
              }
              onViewChange={(viewChange, options) =>
                onTranslationCardViewChange(selection, viewChange, options)
              }
              pinSelection={{
                ...activePopoverSelection,
              }}
              placement={activeSelectionTranslationPlacement.placement}
              paperContext={paperContext}
              selection={activePopoverSelection}
              settings={settings}
              renderInPortal={!isMobileViewport}
              style={
                isMobileViewport
                  ? activeSelectionTranslationPlacement.style
                  : getViewportPopoverStyle(activeSelectionTranslationPlacement.style, pageViewportRect)
              }
              view={activePinnedCard?.view}
              zIndex={
                isMobileViewport
                  ? activePinnedCard?.zIndex ?? activeTranslationCardZIndex
                  : getTranslationCardPortalZIndex(
                      activePinnedCard?.zIndex ?? activeTranslationCardZIndex,
                      portalZIndexSource,
                    )
              }
            />
          ) : null
        : null}
      {pinnedTranslationCardsOnPage.map((card) => {
            const cardSelection = card.selection;
            const cardPin = pins.find((pin) => isSamePinTarget(pin, cardSelection));
            const cardRects = getSelectionRectsOnPage(cardSelection, pageIndex, pageWidth, pageHeight);
            const hydratedCardSelection = hydrateSelectionForCurrentPage(
              cardSelection,
              pageIndex,
              pageWidth,
              pageHeight,
            );
            const isMobileCardOpen = isMobileViewport && activeMobilePinnedCardKey === card.key;
            const shouldShowCardPopover =
              cardSelection.pageIndex === pageIndex &&
              cardSelection.rectsOnPage.length > 0 &&
              (!isMobileViewport || isMobileCardOpen);

            return (
              <div key={card.key}>
                {cardRects.map((rect, index) => (
                  <div
                    aria-hidden="true"
                    className="selection-highlight selection-highlight--pinned"
                    key={`${Math.round(rect.left)}-${Math.round(rect.top)}-pinned-card-${index}`}
                    style={{
                      height: rect.height,
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                    }}
                  />
                ))}
                {isMobileViewport && cardRects.length > 0 ? (
                  <button
                    aria-label={t("translation.openPinned")}
                    aria-pressed={isMobileCardOpen}
                    className={`pinned-card-chip ${isMobileCardOpen ? "pinned-card-chip--active" : ""}`}
                    onClick={() => onOpenMobilePinnedCard(card.key, cardSelection)}
                    style={getPinnedCardChipStyle(cardRects, pageWidth, pageHeight)}
                    title={t("translation.openPinned")}
                    type="button"
                  >
                    <Pin aria-hidden="true" size={13} strokeWidth={2.2} />
                  </button>
                ) : null}
                {shouldShowCardPopover ? (
                  <TranslationPopover
                    annotationColor={cardPin?.color}
                    annotationNote={cardPin?.note}
                    autoTranslate={false}
                    isCardPinned={true}
                    isEmphasized={card.key === emphasizedPinnedCardKey}
                    isFavorited={Boolean(cardPin)}
                    onActivate={() => onActivateTranslationCard(cardSelection)}
                    onAnnotationSave={(payload, annotation) =>
                      onPinTranslation(
                        {
                          ...payload,
                          annotation,
                          pageHeight,
                          pageWidth,
                        },
                        "add",
                      )
                    }
                    onCardPin={(view) =>
                      onPinTranslationCard({
                        placement: card.placement,
                        selection: hydratedCardSelection,
                        style: card.style,
                        view,
                      })
                    }
                    onCollapse={
                      isMobileViewport
                        ? () => onCollapseMobileTranslationCard(cardSelection, true)
                        : undefined
                    }
                    onClose={() => onCloseTranslationCard(cardSelection)}
                    onFavorite={(payload, action) =>
                      onPinTranslation(
                        {
                          ...payload,
                          pageHeight,
                          pageWidth,
                        },
                        action,
                      )
                    }
                    onTranslationComplete={(payload) =>
                      onPinnedTranslationRefresh({
                        ...payload,
                        pageHeight,
                        pageWidth,
                      })
                    }
                    onViewChange={(viewChange, options) =>
                      onTranslationCardViewChange(cardSelection, viewChange, options)
                    }
                    pinSelection={hydratedCardSelection}
                    placement={card.placement}
                    paperContext={paperContext}
                    selection={hydratedCardSelection}
                    settings={settings}
                    renderInPortal={!isMobileViewport}
                    style={
                      isMobileViewport
                        ? card.style
                        : getViewportPopoverStyle(card.style, pageViewportRect)
                    }
                    view={card.view}
                    zIndex={
                      isMobileViewport
                        ? card.zIndex
                        : getTranslationCardPortalZIndex(card.zIndex, portalZIndexSource)
                    }
                  />
                ) : null}
              </div>
            );
          })}
    </div>
  );
}

function SelectActionPopover({
  onClose,
  onCopy,
  onCreateAnnotation,
  onTranslate,
  placement,
  selection,
  style,
}: {
  onClose: () => void;
  onCopy: () => void;
  onCreateAnnotation: (annotation: PinAnnotationInput) => Promise<void>;
  onTranslate: () => void;
  placement: string;
  selection: SentenceSelection;
  style: CSSProperties;
}) {
  const { t } = useI18n();
  const [color, setColor] = useState<AnnotationColor>(DEFAULT_ANNOTATION_COLOR);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");

  function stopEvent(
    event:
      | ReactMouseEvent<HTMLDivElement>
      | ReactPointerEvent<HTMLDivElement>
      | ReactTouchEvent<HTMLDivElement>,
  ) {
    event.stopPropagation();
  }

  async function handleSave() {
    const trimmedNote = note.trim();

    setStatus("saving");

    try {
      await onCreateAnnotation({
        color,
        note: trimmedNote,
      });
    } catch {
      setStatus("error");
    }
  }

  return (
    <div
      className={`select-action-popover select-action-popover--${placement}`}
      onMouseDown={stopEvent}
      onMouseUp={stopEvent}
      onPointerDown={stopEvent}
      onPointerUp={stopEvent}
      onTouchEnd={stopEvent}
      style={style}
    >
      {!isEditorOpen ? (
        <div className="select-action-command-row">
          <span className="select-action-word-count">
            {t("pdf.wordsSelected", { count: countWords(selection.targetSentence) })}
          </span>
          <button
            className="select-action-command-button select-action-command-button--primary"
            onClick={onTranslate}
            type="button"
          >
            <Languages aria-hidden="true" size={15} strokeWidth={2} />
            <span>{t("pdf.translate")}</span>
          </button>
          <button
            className="select-action-command-button"
            onClick={() => setIsEditorOpen(true)}
            type="button"
          >
            <StickyNote aria-hidden="true" size={15} strokeWidth={2} />
            <span>{t("annotation.note")}</span>
          </button>
          <button
            className="select-action-command-button"
            onClick={onCopy}
            type="button"
          >
            <Copy aria-hidden="true" size={15} strokeWidth={2} />
            <span>{t("common.copy")}</span>
          </button>
          <button
            aria-label={t("common.close")}
            className="icon-button icon-button--small pinned-translation-card-action"
            onClick={onClose}
            title={t("common.close")}
            type="button"
          >
            <X aria-hidden="true" size={16} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <div className="select-action-note-panel">
          <div className="select-action-note-toolbar">
            <div className="translation-popover-label">{t("annotation.note")}</div>
            <div className="annotation-color-row" aria-label={t("annotation.color")} role="group">
              {ANNOTATION_COLORS.map((annotationColor) => (
                <button
                  aria-label={t("annotation.colorLabel", { color: getAnnotationColorLabel(annotationColor, t) })}
                  aria-pressed={color === annotationColor}
                  className={`annotation-color-swatch annotation-color-swatch--${annotationColor} ${
                    color === annotationColor ? "annotation-color-swatch--active" : ""
                  }`}
                  key={annotationColor}
                  onClick={() => setColor(annotationColor)}
                  title={getAnnotationColorLabel(annotationColor, t)}
                  type="button"
                />
              ))}
            </div>
            <button
              aria-label={t("annotation.save")}
              className="icon-button icon-button--small pinned-translation-card-action"
              disabled={status === "saving"}
              onClick={() => void handleSave()}
              title={t("annotation.save")}
              type="button"
            >
              <Check aria-hidden="true" size={16} strokeWidth={2} />
            </button>
            <button
              aria-label={t("annotation.closeAnnotationPanel")}
              className="icon-button icon-button--small pinned-translation-card-action"
              onClick={onClose}
              title={t("common.close")}
              type="button"
            >
              <X aria-hidden="true" size={16} strokeWidth={2} />
            </button>
          </div>
          <textarea
            className="select-action-note-input"
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("annotation.addNote")}
            rows={3}
            value={note}
          />
          {status === "error" ? (
            <div className="select-action-error">{t("annotation.saveFailed")}</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function QueuedSelectionActionPopover({
  count,
  onClear,
  onConfirm,
  onUndo,
  placement,
  style,
}: {
  count: number;
  onClear: () => void;
  onConfirm: () => void;
  onUndo: () => void;
  placement: string;
  style: CSSProperties;
}) {
  const { t } = useI18n();
  const confirmLabel = t("pdf.useSelectedRegions");

  function stopEvent(
    event:
      | ReactMouseEvent<HTMLDivElement>
      | ReactPointerEvent<HTMLDivElement>
      | ReactTouchEvent<HTMLDivElement>,
  ) {
    event.stopPropagation();
  }

  return (
    <div
      className={`select-action-popover queued-selection-popover select-action-popover--${placement}`}
      onMouseDown={stopEvent}
      onMouseUp={stopEvent}
      onPointerDown={stopEvent}
      onPointerUp={stopEvent}
      onTouchEnd={stopEvent}
      style={style}
    >
      <div className="select-action-command-row queued-selection-command-row">
        <span className="select-action-word-count">
          {t(count === 1 ? "pdf.regionCount" : "pdf.regionCountPlural", { count })}
        </span>
        <button
          className="select-action-command-button select-action-command-button--primary"
          onClick={onConfirm}
          type="button"
        >
          <Check aria-hidden="true" size={15} strokeWidth={2} />
          <span>{confirmLabel}</span>
        </button>
        <button
          aria-label={t("common.undo")}
          className="icon-button icon-button--small pinned-translation-card-action"
          onClick={onUndo}
          title={t("common.undo")}
          type="button"
        >
          <RotateCcw aria-hidden="true" size={16} strokeWidth={2} />
        </button>
        <button
          aria-label={t("common.clear")}
          className="icon-button icon-button--small pinned-translation-card-action"
          onClick={onClear}
          title={t("common.clear")}
          type="button"
        >
          <X aria-hidden="true" size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

type SelectionRectSource = {
  pageHeight?: number;
  pageIndex: number;
  pageWidth?: number;
  rectsOnPage: DOMRectLike[];
  regions?: SelectionRegion[];
};

type PinMarkerKind = "annotation" | "favorite" | "pin";

type PinMarkerTarget = {
  card?: PinnedTranslationCard;
  color?: AnnotationColor;
  key: string;
  kind: PinMarkerKind;
  pin?: TranslationPin;
  rectSource: SelectionRectSource;
};

function getSelectionRectSourcesOnPage(input: SelectionRectSource, pageIndex: number) {
  if (input.regions && input.regions.length > 0) {
    return input.regions.filter(
      (region) => region.pageIndex === pageIndex && region.rectsOnPage.length > 0,
    );
  }

  return input.pageIndex === pageIndex && input.rectsOnPage.length > 0 ? [input] : [];
}

function getAnchorRectSourceOnPage(input: SelectionRectSource, pageIndex: number) {
  return input.pageIndex === pageIndex && input.rectsOnPage.length > 0 ? input : undefined;
}

function getSelectionRectsOnPage(
  input: SelectionRectSource,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
) {
  return getSelectionRectSourcesOnPage(input, pageIndex).flatMap((source) =>
    scaleStoredRects(source, pageWidth, pageHeight),
  );
}

function hasSelectionOnPage(input: SelectionRectSource, pageIndex: number) {
  return getSelectionRectSourcesOnPage(input, pageIndex).length > 0;
}

function hydrateSelectionForCurrentPage(
  selection: SentenceSelection,
  pageIndex: number,
  pageWidth: number,
  pageHeight: number,
): SentenceSelection {
  const selectionOnCurrentPage =
    selection.pageIndex === pageIndex
      ? {
          ...selection,
          pageHeight,
          pageWidth,
          rectsOnPage: scaleStoredRects(selection, pageWidth, pageHeight),
        }
      : selection;
  const regions = selection.regions?.map((region) =>
    region.pageIndex === pageIndex
      ? {
          ...region,
          pageHeight,
          pageWidth,
          rectsOnPage: scaleStoredRects(region, pageWidth, pageHeight),
        }
      : region,
  );

  return regions
    ? {
        ...selectionOnCurrentPage,
        regions,
      }
    : selectionOnCurrentPage;
}

function scaleStoredRects(
  input: {
    pageHeight?: number;
    pageWidth?: number;
    rectsOnPage: DOMRectLike[];
  },
  pageWidth: number,
  pageHeight: number,
): DOMRectLike[] {
  const scaleX = input.pageWidth && input.pageWidth > 0 ? pageWidth / input.pageWidth : 1;
  const scaleY = input.pageHeight && input.pageHeight > 0 ? pageHeight / input.pageHeight : 1;

  return input.rectsOnPage.map((rect) => {
    const left = rect.left * scaleX;
    const top = rect.top * scaleY;
    const width = rect.width * scaleX;
    const height = rect.height * scaleY;

    return {
      bottom: top + height,
      height,
      left,
      right: left + width,
      top,
      width,
      x: left,
      y: top,
    };
  });
}

function getDraftBadgeStyle(rects: DOMRectLike[], pageWidth: number) {
  if (rects.length === 0) {
    return undefined;
  }

  const bounds = getSelectionBounds(rects);
  const estimatedBadgeWidth = 142;
  const top = bounds.top > 34 ? bounds.top - 32 : bounds.bottom + 8;

  return {
    left: clamp(bounds.left, 8, Math.max(8, pageWidth - estimatedBadgeWidth)),
    top,
  };
}

function getPinnedCardChipStyle(
  rects: DOMRectLike[],
  pageWidth: number,
  pageHeight: number,
): CSSProperties | undefined {
  if (rects.length === 0) {
    return undefined;
  }

  const bounds = getSelectionBounds(rects);
  const chipSize = 26;

  return {
    left: clamp(bounds.right + 4, 8, Math.max(8, pageWidth - chipSize - 8)),
    top: clamp(bounds.top - 2, 8, Math.max(8, pageHeight - chipSize - 8)),
  };
}

function getPinMarkerStyle(
  rects: DOMRectLike[],
  pageWidth: number,
  pageHeight: number,
): CSSProperties | undefined {
  if (rects.length === 0) {
    return undefined;
  }

  const bounds = getSelectionBounds(rects);
  const markerSize = 28;

  return {
    left: clamp(bounds.right + 5, 6, Math.max(6, pageWidth - markerSize - 6)),
    top: clamp(bounds.top - 3, 6, Math.max(6, pageHeight - markerSize - 6)),
  };
}

function getPinMarkerTargets({
  pageIndex,
  pinnedTranslationCards,
  pins,
}: {
  pageIndex: number;
  pinnedTranslationCards: PinnedTranslationCard[];
  pins: TranslationPin[];
}) {
  const markersByTarget = new Map<string, PinMarkerTarget>();

  for (const card of pinnedTranslationCards) {
    if (!hasSelectionOnPage(card.selection, pageIndex)) {
      continue;
    }

    const targetKey = createPinTargetKey(card.selection);

    markersByTarget.set(targetKey, {
      card,
      key: `${targetKey}:marker`,
      kind: "pin",
      rectSource: card.selection,
    });
  }

  for (const pin of pins) {
    if (!hasSelectionOnPage(pin, pageIndex)) {
      continue;
    }

    const targetKey = createPinTargetKey(pin);
    const existingMarker = markersByTarget.get(targetKey);
    const hasAnnotationPayload = hasAnnotation(pin);

    markersByTarget.set(targetKey, {
      card: existingMarker?.card,
      color: hasAnnotationPayload ? getAnnotationColor(pin) : undefined,
      key: `${targetKey}:marker`,
      kind: hasAnnotationPayload ? "annotation" : "favorite",
      pin,
      rectSource: pin,
    });
  }

  return Array.from(markersByTarget.values()).sort(comparePinMarkers);
}

function comparePinMarkers(left: PinMarkerTarget, right: PinMarkerTarget) {
  const leftPriority = getPinMarkerPriority(left.kind);
  const rightPriority = getPinMarkerPriority(right.kind);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  const leftPageIndex = left.rectSource.pageIndex;
  const rightPageIndex = right.rectSource.pageIndex;

  if (leftPageIndex !== rightPageIndex) {
    return leftPageIndex - rightPageIndex;
  }

  return left.key.localeCompare(right.key);
}

function getPinMarkerPriority(kind: PinMarkerKind) {
  switch (kind) {
    case "annotation":
      return 0;
    case "favorite":
      return 1;
    case "pin":
    default:
      return 2;
  }
}

function getPinMarkerLabel(marker: PinMarkerTarget, t: ReturnType<typeof useI18n>["t"]) {
  const page = marker.rectSource.pageIndex + 1;

  if (marker.card) {
    return t("translation.openPinnedForPage", { page });
  }

  switch (marker.kind) {
    case "annotation":
      return t("translation.openAnnotationCardForPage", { page });
    case "favorite":
      return t("translation.openSavedCardForPage", { page });
    case "pin":
    default:
      return t("translation.openPinnedForPage", { page });
  }
}

function getPinMarkerTitle(marker: PinMarkerTarget, t: ReturnType<typeof useI18n>["t"]) {
  if (marker.card) {
    return t("translation.openPinnedTitle");
  }

  switch (marker.kind) {
    case "annotation":
      return t("translation.openAnnotationCard");
    case "favorite":
      return t("translation.openSavedCard");
    case "pin":
    default:
      return t("translation.openPinnedTitle");
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

function hasAnnotation(pin: TranslationPin) {
  return Boolean(pin.color) || Boolean(pin.note?.trim());
}

function countWords(text: string) {
  const matches = text.match(/[\p{L}\p{N}]+(?:[-‐‑‒'][\p{L}\p{N}]+)*/gu);

  return Math.max(1, matches?.length ?? 0);
}

function getAnnotationColor(pin: TranslationPin) {
  return pin.color ?? (pin.highlighted ? "green" : "yellow");
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

function getTranslationCardPortalZIndex(zIndex: number, zIndexSource: number[]) {
  const orderedZIndexes = Array.from(new Set([...zIndexSource, zIndex]))
    .sort((left, right) => left - right);
  const zIndexRank = orderedZIndexes.indexOf(zIndex);

  if (zIndexRank < 0) {
    return TRANSLATION_CARD_PORTAL_Z_INDEX_MIN;
  }

  const rankFromTop = orderedZIndexes.length - 1 - zIndexRank;

  return clamp(
    TRANSLATION_CARD_PORTAL_Z_INDEX_MAX - rankFromTop,
    TRANSLATION_CARD_PORTAL_Z_INDEX_MIN,
    TRANSLATION_CARD_PORTAL_Z_INDEX_MAX,
  );
}

function getViewportPopoverStyle(
  pageStyle: CSSProperties,
  pageViewportRect: PageViewportRect,
): CSSProperties {
  const viewportStyle: CSSProperties = {
    ...pageStyle,
    position: "fixed",
  };
  const left = getCssNumericValue(pageStyle.left);
  const top = getCssNumericValue(pageStyle.top);
  const bottom = getCssNumericValue(pageStyle.bottom);

  delete viewportStyle.right;

  if (typeof left === "number") {
    viewportStyle.left = pageViewportRect.left + left;
  } else {
    delete viewportStyle.left;
  }

  if (typeof top === "number") {
    viewportStyle.top = pageViewportRect.top + top;
    delete viewportStyle.bottom;
  } else if (typeof bottom === "number") {
    viewportStyle.bottom = getViewportHeight() - (pageViewportRect.bottom - bottom);
    delete viewportStyle.top;
  } else {
    delete viewportStyle.top;
    delete viewportStyle.bottom;
  }

  return viewportStyle;
}

function getCssNumericValue(value: CSSProperties[keyof CSSProperties]) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  const numericValue = Number.parseFloat(trimmedValue);

  return Number.isFinite(numericValue) ? numericValue : undefined;
}

function getViewportHeight() {
  return typeof window === "undefined" ? 0 : window.innerHeight;
}
