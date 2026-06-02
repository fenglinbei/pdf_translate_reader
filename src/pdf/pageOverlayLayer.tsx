import { useEffect, useRef, useState } from "react";
import type { PinWriteInput } from "../pins/pinRepository";
import type { DOMRectLike, SentenceSelection, TranslationPin } from "../types/domain";
import { TranslationPopover } from "../translation/TranslationPopover";
import { getPopoverPlacement, getSelectionBounds, type PageGutters } from "./overlayPlacement";

type PageOverlayLayerProps = {
  locatedPinId?: string;
  onCloseSelection: () => void;
  onPinnedTranslationRefresh: (input: PinWriteInput) => void;
  onPinTranslation: (input: PinWriteInput) => Promise<void>;
  pageHeight: number;
  pageIndex: number;
  pageWidth: number;
  pins: TranslationPin[];
  selection?: SentenceSelection;
};

export function PageOverlayLayer({
  locatedPinId,
  onCloseSelection,
  onPinnedTranslationRefresh,
  onPinTranslation,
  pageHeight,
  pageIndex,
  pageWidth,
  pins,
  selection,
}: PageOverlayLayerProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pageGutters, setPageGutters] = useState<PageGutters>({ left: 0, right: 0 });
  const selectionKey = selection
    ? `${selection.pdfFingerprint}:${selection.pageIndex}:${selection.normalizedSentence}`
    : "";
  const hasSelection = Boolean(selection && selection.pageIndex === pageIndex && selection.rectsOnPage.length > 0);
  const locatedPin = pins.find(
    (pin) => pin.id === locatedPinId && pin.pageIndex === pageIndex && pin.rectsOnPage.length > 0,
  );
  const selectionPinned = Boolean(
    selection && pins.some((pin) => isSamePinTarget(pin, selection)),
  );
  const selectionRects =
    selection && hasSelection
      ? scaleStoredRects(selection, pageWidth, pageHeight)
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

  if (!hasSelection && !locatedPin) {
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
      {selection && popoverPlacement ? (
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
