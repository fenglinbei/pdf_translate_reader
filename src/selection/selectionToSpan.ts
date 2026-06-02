import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
import type { DOMRectLike, SentenceSelection } from "../types/domain";
import { DEFAULT_CONTEXT_WINDOW_SIZE } from "./contextWindow";
import {
  findSentenceForRange,
  findSentenceRanges,
  normalizePageText,
  normalizeSentence,
  type NormalizedPageText,
  type SentenceRange,
} from "./sentenceBoundary";

export type PageTextIndex = {
  pageElement: HTMLElement;
  pageIndex: number;
  rawText: string;
  sentences: SentenceRange[];
  spans: TextSpanIndex[];
  text: string;
  textLayerElement: HTMLElement;
  textMap: NormalizedPageText;
};

export type TextSpanIndex = {
  element: HTMLElement;
  normalizedEnd: number;
  normalizedStart: number;
  rawEnd: number;
  rawStart: number;
  sentenceIndex?: number;
  spanIndex: number;
};

export type TextSpanPointerHit = {
  element: HTMLElement;
  pageIndex: number;
  rawEnd: number;
  rawOffset: number;
  rawStart: number;
};

export function createPageTextIndex({
  pageElement,
  pageIndex,
  textContent,
  textDivs,
  textLayerElement,
}: {
  pageElement: HTMLElement;
  pageIndex: number;
  textContent: TextContent;
  textDivs: HTMLElement[];
  textLayerElement: HTMLElement;
}): PageTextIndex {
  const rawParts: string[] = [];
  const rawSpans: Array<Pick<TextSpanIndex, "element" | "rawEnd" | "rawStart" | "spanIndex">> = [];
  let rawCursor = 0;
  let textDivIndex = 0;

  for (const item of textContent.items) {
    if (!isTextItem(item)) {
      continue;
    }

    const element = textDivs[textDivIndex];
    const rawStart = rawCursor;

    rawParts.push(item.str);
    rawCursor += item.str.length;

    const rawEnd = rawCursor;

    if (element) {
      element.dataset.pageIndex = String(pageIndex);
      element.dataset.rawStart = String(rawStart);
      element.dataset.rawEnd = String(rawEnd);
      element.dataset.spanIndex = String(rawSpans.length);
      rawSpans.push({ element, rawEnd, rawStart, spanIndex: rawSpans.length });
    }

    textDivIndex += 1;

    if (item.hasEOL) {
      rawParts.push("\n");
      rawCursor += 1;
    }
  }

  const rawText = rawParts.join("");
  const textMap = normalizePageText(rawText);
  const sentences = findSentenceRanges(textMap.text);
  const spans: TextSpanIndex[] = rawSpans.map((span) => {
    const normalizedStart = clamp(
      textMap.rawToNormalized[span.rawStart] ?? 0,
      0,
      textMap.text.length,
    );
    const normalizedEnd = clamp(
      textMap.rawToNormalized[span.rawEnd] ?? textMap.text.length,
      normalizedStart,
      textMap.text.length,
    );
    const sentence = findSentenceForRange(sentences, normalizedStart, normalizedEnd);
    const indexedSpan: TextSpanIndex = {
      ...span,
      normalizedEnd,
      normalizedStart,
      sentenceIndex: sentence?.index,
    };

    if (typeof sentence?.index === "number") {
      span.element.dataset.sentenceIndex = String(sentence.index);
    }

    return indexedSpan;
  });

  return {
    pageElement,
    pageIndex,
    rawText,
    sentences,
    spans,
    text: textMap.text,
    textLayerElement,
    textMap,
  };
}

export function pointerHitToSentenceSelection({
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
  forwardSentenceCount = 0,
  maxSentenceCount,
  pageIndexes,
  pdfFingerprint,
  pointerHit,
}: {
  contextWindowSize?: number;
  forwardSentenceCount?: number;
  maxSentenceCount?: number;
  pageIndexes: Map<number, PageTextIndex>;
  pdfFingerprint: string;
  pointerHit: TextSpanPointerHit;
}) {
  const pageTextIndex = pageIndexes.get(pointerHit.pageIndex);

  if (!pageTextIndex || pageTextIndex.text.trim().length === 0) {
    return undefined;
  }

  const pointerOffset = clamp(
    pageTextIndex.textMap.rawToNormalized[pointerHit.rawOffset] ?? 0,
    0,
    pageTextIndex.text.length,
  );
  const targetSentence = findSentenceForRange(
    pageTextIndex.sentences,
    pointerOffset,
    pointerOffset + 1,
  );

  if (!targetSentence) {
    return undefined;
  }

  const requestedLastSentenceIndex = Math.min(
    pageTextIndex.sentences.length - 1,
    targetSentence.index + Math.max(0, forwardSentenceCount),
  );
  const lastSentenceIndex = clampLastSentenceIndex({
    firstSentenceIndex: targetSentence.index,
    lastSentenceIndex: requestedLastSentenceIndex,
    maxSentenceCount,
  });

  return createSentenceSelectionFromSentences({
    contextWindowSize,
    pageTextIndex,
    pdfFingerprint,
    targetSentences: pageTextIndex.sentences.slice(targetSentence.index, lastSentenceIndex + 1),
  });
}

export function pointerHitRangeToSentenceSelection({
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
  endHit,
  maxSentenceCount,
  pageIndexes,
  pdfFingerprint,
  startHit,
}: {
  contextWindowSize?: number;
  endHit: TextSpanPointerHit;
  maxSentenceCount?: number;
  pageIndexes: Map<number, PageTextIndex>;
  pdfFingerprint: string;
  startHit: TextSpanPointerHit;
}) {
  if (startHit.pageIndex !== endHit.pageIndex) {
    return undefined;
  }

  const pageTextIndex = pageIndexes.get(startHit.pageIndex);

  if (!pageTextIndex || pageTextIndex.text.trim().length === 0) {
    return undefined;
  }

  const rawStart = Math.min(startHit.rawOffset, endHit.rawOffset);
  const rawEnd = Math.max(startHit.rawOffset, endHit.rawOffset + 1);
  const selectionStart = clamp(
    pageTextIndex.textMap.rawToNormalized[rawStart] ?? 0,
    0,
    pageTextIndex.text.length,
  );
  const selectionEnd = clamp(
    pageTextIndex.textMap.rawToNormalized[rawEnd] ?? pageTextIndex.text.length,
    selectionStart,
    pageTextIndex.text.length,
  );
  const targetSentences = findSentencesForRange(
    pageTextIndex.sentences,
    selectionStart,
    selectionEnd,
    maxSentenceCount,
  );

  if (targetSentences.length === 0) {
    return undefined;
  }

  return createSentenceSelectionFromSentences({
    contextWindowSize,
    pageTextIndex,
    pdfFingerprint,
    targetSentences,
  });
}

export function getTextSpanElementFromTarget(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>("[data-page-index][data-raw-start][data-raw-end]")
    : undefined;
}

export function getTextSpanPointerHit(
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): TextSpanPointerHit | undefined {
  const element = getTextSpanElementFromTarget(target);

  if (!element) {
    return undefined;
  }

  return createPointerHitFromSpan(element, clientX, clientY);
}

export function getTextSpanPointerHitFromPoint(clientX: number, clientY: number) {
  return getTextSpanPointerHit(document.elementFromPoint(clientX, clientY), clientX, clientY);
}

function createSentenceSelectionFromSentences({
  contextWindowSize,
  pageTextIndex,
  pdfFingerprint,
  targetSentences,
}: {
  contextWindowSize: number;
  pageTextIndex: PageTextIndex;
  pdfFingerprint: string;
  targetSentences: SentenceRange[];
}): SentenceSelection {
  const firstSentence = targetSentences[0];
  const lastSentence = targetSentences[targetSentences.length - 1];
  const contextBefore = pageTextIndex.sentences
    .slice(Math.max(0, firstSentence.index - contextWindowSize), firstSentence.index)
    .map((sentence) => sentence.normalized);
  const contextAfter = pageTextIndex.sentences
    .slice(lastSentence.index + 1, lastSentence.index + 1 + contextWindowSize)
    .map((sentence) => sentence.normalized);
  const targetSentence = targetSentences.map((sentence) => sentence.text).join(" ");
  const normalizedSentence = normalizeSentence(
    targetSentences.map((sentence) => sentence.normalized).join(" "),
  );

  return {
    localContextAfter: contextAfter,
    localContextBefore: contextBefore,
    normalizedSentence,
    pageIndex: pageTextIndex.pageIndex,
    pdfFingerprint,
    rectsOnPage: getSentenceRectsOnPage(
      pageTextIndex,
      firstSentence.start,
      lastSentence.end,
    ),
    selectedText: normalizedSentence,
    targetSentence,
    textSpan: {
      endGlobalChar: lastSentence.end,
      startGlobalChar: firstSentence.start,
    },
  };
}

function findSentencesForRange(
  sentences: SentenceRange[],
  selectionStart: number,
  selectionEnd: number,
  maxSentenceCount?: number,
) {
  const overlappingSentences = sentences.filter(
    (sentence) => selectionStart < sentence.end && selectionEnd > sentence.start,
  );

  if (overlappingSentences.length > 0) {
    const firstIndex = overlappingSentences[0].index;
    const requestedLastIndex = overlappingSentences[overlappingSentences.length - 1].index;
    const lastIndex = clampLastSentenceIndex({
      firstSentenceIndex: firstIndex,
      lastSentenceIndex: requestedLastIndex,
      maxSentenceCount,
    });

    return sentences.slice(firstIndex, lastIndex + 1);
  }

  const fallbackSentence = findSentenceForRange(sentences, selectionStart, selectionEnd);

  return fallbackSentence ? [fallbackSentence] : [];
}

function clampLastSentenceIndex({
  firstSentenceIndex,
  lastSentenceIndex,
  maxSentenceCount,
}: {
  firstSentenceIndex: number;
  lastSentenceIndex: number;
  maxSentenceCount?: number;
}) {
  if (!maxSentenceCount || maxSentenceCount < 1) {
    return lastSentenceIndex;
  }

  return Math.min(lastSentenceIndex, firstSentenceIndex + maxSentenceCount - 1);
}

function createPointerHitFromSpan(
  element: HTMLElement,
  clientX: number,
  clientY: number,
): TextSpanPointerHit | undefined {
  const pageIndex = Number(element.dataset.pageIndex);
  const rawStart = Number(element.dataset.rawStart);
  const rawEnd = Number(element.dataset.rawEnd);

  if (!Number.isFinite(pageIndex) || !Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
    return undefined;
  }

  const localOffset = getPointerTextOffset(element, clientX, clientY);

  return {
    element,
    pageIndex,
    rawEnd,
    rawOffset: rawStart + clamp(localOffset, 0, Math.max(0, rawEnd - rawStart)),
    rawStart,
  };
}

function getPointerTextOffset(element: HTMLElement, clientX: number, clientY: number) {
  const caretPositionFromPoint = document.caretPositionFromPoint?.(clientX, clientY);

  if (caretPositionFromPoint && element.contains(caretPositionFromPoint.offsetNode)) {
    return getTextOffsetFromNode(
      element,
      caretPositionFromPoint.offsetNode,
      caretPositionFromPoint.offset,
    );
  }

  const caretRangeFromPoint = document.caretRangeFromPoint?.(clientX, clientY);

  if (caretRangeFromPoint && element.contains(caretRangeFromPoint.startContainer)) {
    return getTextOffsetFromNode(
      element,
      caretRangeFromPoint.startContainer,
      caretRangeFromPoint.startOffset,
    );
  }

  const rect = element.getBoundingClientRect();
  const textLength = element.textContent?.length ?? 0;
  const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;

  return Math.round(clamp(ratio, 0, 1) * textLength);
}

function getTextOffsetFromNode(element: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();

  range.selectNodeContents(element);
  range.setEnd(node, offset);

  const textOffset = range.toString().length;

  range.detach();

  return textOffset;
}

function getSentenceRectsOnPage(
  pageTextIndex: PageTextIndex,
  normalizedStart: number,
  normalizedEnd: number,
) {
  return pageTextIndex.spans
    .filter(
      (span) =>
        span.normalizedStart < normalizedEnd &&
        span.normalizedEnd > normalizedStart &&
        (span.element.textContent ?? "").trim().length > 0,
    )
    .flatMap((span) => getElementRectsOnPage(span.element, pageTextIndex.pageElement));
}

function getElementRectsOnPage(element: HTMLElement, pageElement: HTMLElement): DOMRectLike[] {
  const pageRect = pageElement.getBoundingClientRect();

  return Array.from(element.getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0 && intersects(rect, pageRect))
    .map((rect) => {
      const left = rect.left - pageRect.left;
      const top = rect.top - pageRect.top;
      const width = rect.width;
      const height = rect.height;

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

function intersects(rect: DOMRect, pageRect: DOMRect) {
  return (
    rect.right >= pageRect.left &&
    rect.left <= pageRect.right &&
    rect.bottom >= pageRect.top &&
    rect.top <= pageRect.bottom
  );
}

function isTextItem(item: TextContent["items"][number]): item is TextItem {
  return "str" in item;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
