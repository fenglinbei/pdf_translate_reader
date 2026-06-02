import { useEffect, useRef, useState } from "react";
import type { PinWriteInput } from "../pins/pinRepository";
import type { AppSettings, DOMRectLike, SentenceSelection, TranslationPin } from "../types/domain";
import { TranslationPopover } from "../translation/TranslationPopover";
import { getPopoverPlacement, getSelectionBounds, type PageGutters } from "./overlayPlacement";

type PageOverlayLayerProps = {
  draftSelection?: SentenceSelection;
  locatedPinId?: string;
  onCloseSelection: () => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (input: PinWriteInput) => Promise<void>;
  pageHeight: number;
  pageIndex: number;
  pageWidth: number;
  pins: TranslationPin[];
  selection?: SentenceSelection;
  settings: AppSettings;
};

export function PageOverlayLayer({
  draftSelection,
  locatedPinId,
  onCloseSelection,
  onPinnedTranslationRefresh,
  onPinTranslation,
  pageHeight,
  pageIndex,
  pageWidth,
  pins,
  selection,
  settings,
}: PageOverlayLayerProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pageGutters, setPageGutters] = useState<PageGutters>({ left: 0, right: 0 });
  const selectionKey = selection
    ? `${selection.pdfFingerprint}:${selection.pageIndex}:${selection.normalizedSentence}`
    : "";
  const hasSelection = Boolean(selection && selection.pageIndex === pageIndex && selection.rectsOnPage.length > 0);
  const hasDraftSelection = Boolean(
    draftSelection && draftSelection.pageIndex === pageIndex && draftSelection.rectsOnPage.length > 0,
  );
  const locatedPin = pins.find(
    (pin) => pin.id === locatedPinId && pin.pageIndex === pageIndex && pin.rectsOnPage.length > 0,
  );
  const highlightedPins = pins.filter(
    (pin) => pin.highlighted && pin.pageIndex === pageIndex && pin.rectsOnPage.length > 0,
  );
  const selectionPinned = Boolean(
    selection && pins.some((pin) => isSamePinTarget(pin, selection)),
  );
  const selectionRects =
    selection && hasSelection
      ? scaleStoredRects(selection, pageWidth, pageHeight)
      : [];
  const draftRects =
    draftSelection && hasDraftSelection
      ? scaleStoredRects(draftSelection, pageWidth, pageHeight)
      : [];

  useEffect(() => {
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
  }, [pageHeight, pageWidth, selectionKey]);

  if (!hasSelection && !hasDraftSelection && highlightedPins.length === 0 && !locatedPin) {
    return <div className="pdf-page-overlay" ref={overlayRef} />;
  }

  const popoverPlacement =
    selection && hasSelection
      ? getPopoverPlacement(getSelectionBounds(selectionRects), {
          gutters: pageGutters,
          height: pageHeight,
          width: pageWidth,
        })
      : undefined;

  return (
    <div className="pdf-page-overlay" ref={overlayRef}>
      {highlightedPins.flatMap((pin) =>
        scaleStoredRects(pin, pageWidth, pageHeight).map((rect, index) => (
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
        ? scaleStoredRects(locatedPin, pageWidth, pageHeight).map((rect, index) => (
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
      {selection && popoverPlacement && !hasDraftSelection ? (
        <>
          {selectionRects.map((rect, index) => (
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
          ))}
          <TranslationPopover
            isPinned={selectionPinned}
            onClose={onCloseSelection}
            onPin={(payload) =>
              onPinTranslation({
                ...payload,
                pageHeight,
                pageWidth,
              })
            }
            onTranslationComplete={(payload) =>
              onPinnedTranslationRefresh({
                ...payload,
                pageHeight,
                pageWidth,
              })
            }
            pinSelection={{
              ...selection,
              pageHeight,
              pageWidth,
              rectsOnPage: selectionRects,
            }}
            placement={popoverPlacement.placement}
            selection={selection}
            settings={settings}
            style={popoverPlacement.style}
          />
        </>
      ) : null}
    </div>
  );
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
