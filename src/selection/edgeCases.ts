import type { SentenceSelection } from "../types/domain";
import type { PageTextIndex, TextSpanPointerHit } from "./selectionToSpan";

export const CROSS_PAGE_SELECTION_MESSAGE = "Cross-page selection is not supported yet.";
export const OCR_UNSUPPORTED_MESSAGE = "This page has no selectable text. OCR is not supported yet.";
export const TEXT_ORDER_UNRELIABLE_MESSAGE =
  "PDF text order may be unreliable on this page. Check the selected sentence before translating.";

const COLUMN_JUMP_MIN_X_PX = 80;
const COLUMN_JUMP_MIN_Y_PX = 48;
const LONG_SELECTION_WARNING_CHARS = 1600;

export function isCrossPageSelection(
  startHit: TextSpanPointerHit,
  latestHit: TextSpanPointerHit | undefined,
) {
  return Boolean(latestHit && latestHit.pageIndex !== startHit.pageIndex);
}

export function hasUsableTextLayerText(text: string) {
  return /[\p{L}\p{N}]/u.test(text);
}

export function getTextOrderWarning(
  pageTextIndex: PageTextIndex | undefined,
  selection: SentenceSelection,
) {
  if (selection.targetSentence.length > LONG_SELECTION_WARNING_CHARS) {
    return TEXT_ORDER_UNRELIABLE_MESSAGE;
  }

  if (!pageTextIndex) {
    return undefined;
  }

  const selectedSpans = pageTextIndex.spans.filter(
    (span) =>
      selection.textSpan.startGlobalChar < span.normalizedEnd &&
      selection.textSpan.endGlobalChar > span.normalizedStart,
  );

  if (selectedSpans.length < 2) {
    return undefined;
  }

  let previousRect = selectedSpans[0].element.getBoundingClientRect();

  for (const span of selectedSpans.slice(1)) {
    const rect = span.element.getBoundingClientRect();
    const jumpsUp = rect.top < previousRect.top - COLUMN_JUMP_MIN_Y_PX;
    const jumpsRight = rect.left > previousRect.left + COLUMN_JUMP_MIN_X_PX;

    if (jumpsUp && jumpsRight) {
      return TEXT_ORDER_UNRELIABLE_MESSAGE;
    }

    previousRect = rect;
  }

  return undefined;
}
