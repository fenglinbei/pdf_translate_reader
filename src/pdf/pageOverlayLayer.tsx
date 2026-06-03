import { useEffect, useRef, useState } from "react";
import type { PinWriteInput } from "../pins/pinRepository";
import type {
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
} from "../translation/floatingCardTypes";
import { TranslationPopover } from "../translation/TranslationPopover";
import { getPopoverPlacement, getSelectionBounds, type PageGutters } from "./overlayPlacement";

type PageOverlayLayerProps = {
  activeTranslationCardZIndex: number;
  copyNotice?: string;
  copySelection?: SentenceSelection;
  draftSelection?: SentenceSelection;
  locatedPinId?: string;
  onActivateTranslationCard: (selection: SentenceSelection) => void;
  onCloseTranslationCard: (selection: SentenceSelection) => void;
  onPinTranslationCard: (input: TranslationCardPinInput) => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (
    input: PinWriteInput,
    action: TranslationFavoriteAction,
  ) => Promise<void>;
  onTranslationCardViewChange: (
    selection: SentenceSelection,
    viewChange: TranslationCardViewChange,
  ) => void;
  pageHeight: number;
  pageIndex: number;
  pageWidth: number;
  paperContext?: PaperContext;
  pinnedTranslationCards: PinnedTranslationCard[];
  pins: TranslationPin[];
  queuedSelections?: SentenceSelection[];
  selection?: SentenceSelection;
  settings: AppSettings;
};

export function PageOverlayLayer({
  activeTranslationCardZIndex,
  copyNotice,
  copySelection,
  draftSelection,
  locatedPinId,
  onActivateTranslationCard,
  onCloseTranslationCard,
  onPinTranslationCard,
  onPinnedTranslationRefresh,
  onPinTranslation,
  onTranslationCardViewChange,
  pageHeight,
  pageIndex,
  pageWidth,
  paperContext,
  pinnedTranslationCards,
  pins,
  queuedSelections = [],
  selection,
  settings,
}: PageOverlayLayerProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pageGutters, setPageGutters] = useState<PageGutters>({ left: 0, right: 0 });
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
  const pinnedTranslationCardsOnPage = pinnedTranslationCards.filter(
    (card) =>
      hasSelectionOnPage(card.selection, pageIndex) &&
      !(selection && isSamePinTarget(card.selection, selection)),
  );
  const locatedPin = pins.find(
    (pin) => pin.id === locatedPinId && hasSelectionOnPage(pin, pageIndex),
  );
  const highlightedPins = pins.filter(
    (pin) => pin.highlighted && hasSelectionOnPage(pin, pageIndex),
  );
  const selectionPinned = Boolean(
    selection && pins.some((pin) => isSamePinTarget(pin, selection)),
  );
  const activePinnedCard = selection
    ? pinnedTranslationCards.find((card) => isSamePinTarget(card.selection, selection))
    : undefined;
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
  const needsPopoverPlacement = Boolean(selection && selectionAnchorRects.length > 0);

  useEffect(() => {
    if (!needsPopoverPlacement) {
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

    function updatePageGutters() {
      const pageRect = currentPageElement.getBoundingClientRect();
      const scrollRect = currentScrollElement.getBoundingClientRect();

      setPageGutters({
        left: Math.max(0, pageRect.left - scrollRect.left),
        right: Math.max(0, scrollRect.right - pageRect.right),
      });
    }

    const resizeObserver = new ResizeObserver(updatePageGutters);

    updatePageGutters();
    resizeObserver.observe(currentPageElement);
    resizeObserver.observe(currentScrollElement);
    currentScrollElement.addEventListener("scroll", updatePageGutters, { passive: true });
    window.addEventListener("resize", updatePageGutters);

    return () => {
      resizeObserver.disconnect();
      currentScrollElement.removeEventListener("scroll", updatePageGutters);
      window.removeEventListener("resize", updatePageGutters);
    };
  }, [needsPopoverPlacement, pageHeight, pageWidth, selectionKey]);

  if (
    !hasSelection &&
    !hasCopySelection &&
    !hasDraftSelection &&
    queuedSelectionRects.length === 0 &&
    pinnedTranslationCardsOnPage.length === 0 &&
    highlightedPins.length === 0 &&
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
  const activePopoverSelection =
    selection && popoverPlacement
      ? hydrateSelectionForCurrentPage(selection, pageIndex, pageWidth, pageHeight)
      : undefined;

  return (
    <div className="pdf-page-overlay" ref={overlayRef}>
      {highlightedPins.flatMap((pin) =>
        getSelectionRectsOnPage(pin, pageIndex, pageWidth, pageHeight).map((rect, index) => (
          <div
            aria-hidden="true"
            className="selection-highlight selection-highlight--pinned"
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
            Selecting {countWords(draftSelection?.targetSentence ?? "")} words
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
      {selection && activePopoverSelection && popoverPlacement && !hasDraftSelection ? (
        <TranslationPopover
          isCardPinned={Boolean(activePinnedCard)}
          isFavorited={selectionPinned}
          onActivate={() => onActivateTranslationCard(selection)}
          onCardPin={(view) =>
            onPinTranslationCard({
              placement: activePinnedCard?.placement ?? popoverPlacement.placement,
              selection: activePopoverSelection,
              style: activePinnedCard?.style ?? popoverPlacement.style,
              view,
            })
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
          onViewChange={(viewChange) => onTranslationCardViewChange(selection, viewChange)}
          pinSelection={{
            ...activePopoverSelection,
          }}
          placement={activePinnedCard?.placement ?? popoverPlacement.placement}
          paperContext={paperContext}
          selection={activePopoverSelection}
          settings={settings}
          style={activePinnedCard?.style ?? popoverPlacement.style}
          view={activePinnedCard?.view}
          zIndex={activePinnedCard?.zIndex ?? activeTranslationCardZIndex}
        />
      ) : null}
      {pinnedTranslationCardsOnPage.map((card) => {
            const cardSelection = card.selection;
            const cardRects = getSelectionRectsOnPage(cardSelection, pageIndex, pageWidth, pageHeight);
            const hydratedCardSelection = hydrateSelectionForCurrentPage(
              cardSelection,
              pageIndex,
              pageWidth,
              pageHeight,
            );
            const shouldShowCardPopover =
              cardSelection.pageIndex === pageIndex && cardSelection.rectsOnPage.length > 0;

            return (
              <div key={card.key}>
                {cardRects.map((rect, index) => (
                  <div
                    aria-hidden="true"
                    className="selection-highlight"
                    key={`${Math.round(rect.left)}-${Math.round(rect.top)}-pinned-card-${index}`}
                    style={{
                      height: rect.height,
                      left: rect.left,
                      top: rect.top,
                      width: rect.width,
                    }}
                  />
                ))}
                {shouldShowCardPopover ? (
                  <TranslationPopover
                    isCardPinned={true}
                    isFavorited={pins.some((pin) => isSamePinTarget(pin, cardSelection))}
                    onActivate={() => onActivateTranslationCard(cardSelection)}
                    onCardPin={(view) =>
                      onPinTranslationCard({
                        placement: card.placement,
                        selection: hydratedCardSelection,
                        style: card.style,
                        view,
                      })
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
                    onViewChange={(viewChange) =>
                      onTranslationCardViewChange(cardSelection, viewChange)
                    }
                    pinSelection={hydratedCardSelection}
                    placement={card.placement}
                    paperContext={paperContext}
                    selection={hydratedCardSelection}
                    settings={settings}
                    style={card.style}
                    view={card.view}
                    zIndex={card.zIndex}
                  />
                ) : null}
              </div>
            );
          })}
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

function countWords(text: string) {
  const matches = text.match(/[\p{L}\p{N}]+(?:[-‐‑‒'][\p{L}\p{N}]+)*/gu);

  return Math.max(1, matches?.length ?? 0);
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
