import type { TextSpanPointerHit } from "./selectionToSpan";

export const CROSS_PAGE_SELECTION_MESSAGE = "Cross-page selection is not supported yet.";
export const OCR_UNSUPPORTED_MESSAGE = "This page has no selectable text. OCR is not supported yet.";

export function isCrossPageSelection(
  startHit: TextSpanPointerHit,
  latestHit: TextSpanPointerHit | undefined,
) {
  return Boolean(latestHit && latestHit.pageIndex !== startHit.pageIndex);
}

export function hasUsableTextLayerText(text: string) {
  return /[\p{L}\p{N}]/u.test(text);
}
