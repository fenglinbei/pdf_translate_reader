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
  words: WordRange[];
};

export type PageTextMetadata = {
  rawSpanRanges: RawSpanRange[];
  rawText: string;
  sentences: SentenceRange[];
  text: string;
  textMap: NormalizedPageText;
  words: WordRange[];
};
type RawSpanRange = {
  rawEnd: number;
  rawStart: number;
  spanIndex: number;
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

export type WordRange = {
  end: number;
  start: number;
};

export function createPageTextIndex({
  pageElement,
  pageIndex,
  textMetadata,
  textContent,
  textDivs,
  textLayerElement,
}: {
  pageElement: HTMLElement;
  pageIndex: number;
  textMetadata?: PageTextMetadata;
  textContent: TextContent;
  textDivs: HTMLElement[];
  textLayerElement: HTMLElement;
}): PageTextIndex {
  const metadata = textMetadata ?? createPageTextMetadata(textContent);
  const spans: TextSpanIndex[] = metadata.rawSpanRanges
    .map((span) => {
      const element = textDivs[span.spanIndex];

      if (!element) {
        return undefined;
      }

      element.dataset.pageIndex = String(pageIndex);
      element.dataset.rawStart = String(span.rawStart);
      element.dataset.rawEnd = String(span.rawEnd);
      element.dataset.spanIndex = String(span.spanIndex);

      const normalizedStart = clamp(
        metadata.textMap.rawToNormalized[span.rawStart] ?? 0,
        0,
        metadata.text.length,
      );
      const normalizedEnd = clamp(
        metadata.textMap.rawToNormalized[span.rawEnd] ?? metadata.text.length,
        normalizedStart,
        metadata.text.length,
      );
      const sentence = findSentenceForRange(metadata.sentences, normalizedStart, normalizedEnd);
      const indexedSpan: TextSpanIndex = {
        ...span,
        element,
        normalizedEnd,
        normalizedStart,
        sentenceIndex: sentence?.index,
      };

      if (typeof sentence?.index === "number") {
        element.dataset.sentenceIndex = String(sentence.index);
      }

      return indexedSpan;
    })
    .filter((span): span is TextSpanIndex => Boolean(span));

  return {
    pageElement,
    pageIndex,
    rawText: metadata.rawText,
    sentences: metadata.sentences,
    spans,
    text: metadata.text,
    textLayerElement,
    textMap: metadata.textMap,
    words: metadata.words,
  };
}

export function createPageTextMetadata(textContent: TextContent): PageTextMetadata {
  const rawParts: string[] = [];
  const rawSpanRanges: RawSpanRange[] = [];
  let rawCursor = 0;
  let textDivIndex = 0;

  for (const item of textContent.items) {
    if (!isTextItem(item)) {
      continue;
    }

    const rawStart = rawCursor;

    rawParts.push(item.str);
    rawCursor += item.str.length;

    const rawEnd = rawCursor;

    rawSpanRanges.push({ rawEnd, rawStart, spanIndex: textDivIndex });

    textDivIndex += 1;

    if (item.hasEOL) {
      rawParts.push("\n");
      rawCursor += 1;
    }
  }

  const rawText = rawParts.join("");
  const textMap = normalizePageText(rawText);
  const sentences = findSentenceRanges(textMap.text);
  const words = findWordRanges(textMap.text);

  return {
    rawSpanRanges,
    rawText,
    sentences,
    text: textMap.text,
    textMap,
    words,
  };
}

export function pointerHitRangeToWordSelection({
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
  endHit,
  maxWordCount,
  pageIndexes,
  pdfFingerprint,
  startHit,
}: {
  contextWindowSize?: number;
  endHit: TextSpanPointerHit;
  maxWordCount?: number;
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
  const snappedRange = snapRangeToWords(pageTextIndex.text, pageTextIndex.words, selectionStart, selectionEnd);

  if (!snappedRange) {
    return undefined;
  }

  const wordLimitedRange = clampWordRangeToMaxWords(
    pageTextIndex.text,
    pageTextIndex.words,
    snappedRange,
    maxWordCount,
    startHit.rawOffset <= endHit.rawOffset,
  );
  let targetStart = wordLimitedRange.start;
  let targetEnd = wordLimitedRange.end;
  const targetSentences = findSentencesForRange(
    pageTextIndex.sentences,
    targetStart,
    targetEnd,
  );

  if (targetSentences.length > 0) {
    targetStart = Math.max(targetStart, targetSentences[0].start);
    targetEnd = Math.min(targetEnd, targetSentences[targetSentences.length - 1].end);
  }

  return createTextSelectionFromRange({
    contextWindowSize,
    normalizedEnd: targetEnd,
    normalizedStart: targetStart,
    pageTextIndex,
    pdfFingerprint,
    targetSentences,
  });
}

export function pointerHitToSentenceSelection({
  contextWindowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
  hit,
  pageIndexes,
  pdfFingerprint,
}: {
  contextWindowSize?: number;
  hit: TextSpanPointerHit;
  pageIndexes: Map<number, PageTextIndex>;
  pdfFingerprint: string;
}) {
  const pageTextIndex = pageIndexes.get(hit.pageIndex);

  if (!pageTextIndex || pageTextIndex.text.trim().length === 0) {
    return undefined;
  }

  const normalizedOffset = clamp(
    pageTextIndex.textMap.rawToNormalized[hit.rawOffset] ?? 0,
    0,
    pageTextIndex.text.length,
  );
  const targetSentence = findSentenceForRange(
    pageTextIndex.sentences,
    normalizedOffset,
    normalizedOffset + 1,
  );

  if (!targetSentence) {
    return undefined;
  }

  return createTextSelectionFromRange({
    contextWindowSize,
    normalizedEnd: targetSentence.end,
    normalizedStart: targetSentence.start,
    pageTextIndex,
    pdfFingerprint,
    targetSentences: [targetSentence],
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

function createTextSelectionFromRange({
  contextWindowSize,
  normalizedEnd,
  normalizedStart,
  pageTextIndex,
  pdfFingerprint,
  targetSentences,
}: {
  contextWindowSize: number;
  normalizedEnd: number;
  normalizedStart: number;
  pageTextIndex: PageTextIndex;
  pdfFingerprint: string;
  targetSentences: SentenceRange[];
}): SentenceSelection | undefined {
  const safeStart = clamp(normalizedStart, 0, pageTextIndex.text.length);
  const safeEnd = clamp(normalizedEnd, safeStart, pageTextIndex.text.length);
  const targetSentence = pageTextIndex.text.slice(safeStart, safeEnd).trim();
  const normalizedSentence = normalizeSentence(targetSentence);

  if (normalizedSentence.length === 0) {
    return undefined;
  }

  const firstContextSentence =
    targetSentences[0] ?? findSentenceForRange(pageTextIndex.sentences, safeStart, safeEnd);
  const lastContextSentence = targetSentences[targetSentences.length - 1] ?? firstContextSentence;
  const contextBefore = firstContextSentence
    ? pageTextIndex.sentences
        .slice(Math.max(0, firstContextSentence.index - contextWindowSize), firstContextSentence.index)
        .map((sentence) => sentence.normalized)
    : [];
  const contextAfter = lastContextSentence
    ? pageTextIndex.sentences
        .slice(lastContextSentence.index + 1, lastContextSentence.index + 1 + contextWindowSize)
        .map((sentence) => sentence.normalized)
    : [];

  return {
    localContextAfter: contextAfter,
    localContextBefore: contextBefore,
    normalizedSentence,
    pageIndex: pageTextIndex.pageIndex,
    pdfFingerprint,
    rectsOnPage: getRangeRectsOnPage(pageTextIndex, safeStart, safeEnd),
    selectedText: normalizedSentence,
    targetSentence,
    textSpan: {
      endGlobalChar: safeEnd,
      startGlobalChar: safeStart,
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

function findWordRanges(text: string): WordRange[] {
  const intlRanges = findIntlWordRanges(text);
  const ranges = intlRanges.length > 0 ? intlRanges : findFallbackWordRanges(text);

  return mergeHyphenatedWordRanges(text, ranges);
}

function findIntlWordRanges(text: string): WordRange[] {
  type WordSegment = {
    index: number;
    isWordLike?: boolean;
    segment: string;
  };
  type SegmenterConstructor = new (
    locale: string,
    options: { granularity: "word" },
  ) => {
    segment(value: string): Iterable<WordSegment>;
  };
  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter;

  if (!Segmenter) {
    return [];
  }

  return Array.from(new Segmenter("en", { granularity: "word" }).segment(text))
    .filter((segment) => segment.isWordLike)
    .map((segment) => ({
      end: segment.index + segment.segment.length,
      start: segment.index,
    }));
}

function findFallbackWordRanges(text: string): WordRange[] {
  const ranges: WordRange[] = [];
  const wordPattern = /[\p{L}\p{N}]+(?:[-‐‑‒'][\p{L}\p{N}]+)*/gu;

  for (const match of text.matchAll(wordPattern)) {
    ranges.push({
      end: match.index + match[0].length,
      start: match.index,
    });
  }

  return ranges;
}

function mergeHyphenatedWordRanges(text: string, ranges: WordRange[]) {
  if (ranges.length <= 1) {
    return ranges;
  }

  const mergedRanges: WordRange[] = [];
  let currentRange = ranges[0];

  for (const nextRange of ranges.slice(1)) {
    const gap = text.slice(currentRange.end, nextRange.start);

    if (/^[-‐‑‒]+$/.test(gap)) {
      currentRange = {
        end: nextRange.end,
        start: currentRange.start,
      };
    } else {
      mergedRanges.push(currentRange);
      currentRange = nextRange;
    }
  }

  mergedRanges.push(currentRange);

  return mergedRanges;
}

function snapRangeToWords(
  text: string,
  words: WordRange[],
  selectionStart: number,
  selectionEnd: number,
): WordRange | undefined {
  if (words.length === 0) {
    return undefined;
  }

  const start = Math.min(selectionStart, selectionEnd);
  const end = Math.max(selectionStart, selectionEnd);
  const overlappingWords = words.filter((word) => start < word.end && end > word.start);

  if (overlappingWords.length === 0) {
    const nearestWord = findNearestWord(words, start);

    return nearestWord ? expandRangeToAdjacentPunctuation(text, nearestWord) : undefined;
  }

  return expandRangeToAdjacentPunctuation(text, {
    end: overlappingWords[overlappingWords.length - 1].end,
    start: overlappingWords[0].start,
  });
}

function clampWordRangeToMaxWords(
  text: string,
  words: WordRange[],
  range: WordRange,
  maxWordCount: number | undefined,
  keepFromStart: boolean,
) {
  if (!maxWordCount || maxWordCount < 1) {
    return range;
  }

  const overlappingWords = words.filter((word) => range.start < word.end && range.end > word.start);

  if (overlappingWords.length <= maxWordCount) {
    return range;
  }

  const keptWords = keepFromStart
    ? overlappingWords.slice(0, maxWordCount)
    : overlappingWords.slice(-maxWordCount);

  return expandRangeToAdjacentPunctuation(text, {
    end: keptWords[keptWords.length - 1].end,
    start: keptWords[0].start,
  });
}

function findNearestWord(words: WordRange[], offset: number) {
  let nearestWord: WordRange | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const word of words) {
    const distance =
      offset < word.start
        ? word.start - offset
        : offset > word.end
          ? offset - word.end
          : 0;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestWord = word;
    }
  }

  return nearestWord;
}

function expandRangeToAdjacentPunctuation(text: string, range: WordRange): WordRange {
  let start = range.start;
  let end = range.end;

  while (start > 0 && isOpeningPunctuation(text[start - 1])) {
    start -= 1;
  }

  while (end < text.length && isClosingOrTrailingPunctuation(text[end])) {
    end += 1;
  }

  return { end, start };
}

function isOpeningPunctuation(character: string) {
  return /["'([{“‘]/.test(character);
}

function isClosingOrTrailingPunctuation(character: string) {
  return /[.,;:!?%")\]}”’]/.test(character);
}

function getRangeRectsOnPage(
  pageTextIndex: PageTextIndex,
  normalizedStart: number,
  normalizedEnd: number,
) {
  const rawStart = getRawStartForNormalizedOffset(pageTextIndex, normalizedStart);
  const rawEnd = getRawEndForNormalizedOffset(pageTextIndex, normalizedEnd);
  const preciseRects = pageTextIndex.spans
    .filter(
      (span) =>
        span.rawStart < rawEnd &&
        span.rawEnd > rawStart &&
        (span.element.textContent ?? "").trim().length > 0,
    )
    .flatMap((span) => {
      const localStart = clamp(rawStart - span.rawStart, 0, Math.max(0, span.rawEnd - span.rawStart));
      const localEnd = clamp(rawEnd - span.rawStart, localStart, Math.max(0, span.rawEnd - span.rawStart));

      return getElementRangeRectsOnPage(
        span.element,
        pageTextIndex.pageElement,
        localStart,
        localEnd,
      );
    });

  return preciseRects.length > 0
    ? preciseRects
    : getSentenceRectsOnPage(pageTextIndex, normalizedStart, normalizedEnd);
}

function getRawStartForNormalizedOffset(pageTextIndex: PageTextIndex, normalizedOffset: number) {
  if (normalizedOffset >= pageTextIndex.text.length) {
    return pageTextIndex.rawText.length;
  }

  return pageTextIndex.textMap.normalizedToRaw[normalizedOffset] ?? pageTextIndex.rawText.length;
}

function getRawEndForNormalizedOffset(pageTextIndex: PageTextIndex, normalizedOffset: number) {
  if (normalizedOffset <= 0) {
    return 0;
  }

  if (normalizedOffset >= pageTextIndex.text.length) {
    return pageTextIndex.rawText.length;
  }

  return (pageTextIndex.textMap.normalizedToRaw[normalizedOffset - 1] ?? pageTextIndex.rawText.length - 1) + 1;
}

function getElementRangeRectsOnPage(
  element: HTMLElement,
  pageElement: HTMLElement,
  startOffset: number,
  endOffset: number,
): DOMRectLike[] {
  const textLength = element.textContent?.length ?? 0;

  if (startOffset <= 0 && endOffset >= textLength) {
    return getElementRectsOnPage(element, pageElement);
  }

  const rangeStart = getTextNodePositionAtOffset(element, startOffset);
  const rangeEnd = getTextNodePositionAtOffset(element, endOffset);

  if (!rangeStart || !rangeEnd) {
    return getElementRectsOnPage(element, pageElement);
  }

  const pageRect = pageElement.getBoundingClientRect();
  const range = document.createRange();

  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);

  const rects = Array.from(range.getClientRects())
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

  range.detach();

  return rects;
}

function getTextNodePositionAtOffset(element: HTMLElement, offset: number) {
  const targetOffset = clamp(offset, 0, element.textContent?.length ?? 0);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remainingOffset = targetOffset;
  let latestTextNode: Text | undefined;

  while (true) {
    const node = walker.nextNode() as Text | null;

    if (!node) {
      break;
    }

    latestTextNode = node;

    if (remainingOffset <= node.data.length) {
      return {
        node,
        offset: remainingOffset,
      };
    }

    remainingOffset -= node.data.length;
  }

  return latestTextNode
    ? {
        node: latestTextNode,
        offset: latestTextNode.data.length,
      }
    : undefined;
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
