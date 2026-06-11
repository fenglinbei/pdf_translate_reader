import type {
  DOMRectLike,
  MathpixParsedLine,
  MathpixParsedPage,
  SelectionRegion,
  SentenceSelection,
} from "../types/domain";
import { normalizeSentence } from "../selection/sentenceBoundary";
import { cleanExtractedText } from "../selection/textProcessing";
import { joinMathpixLines } from "./mathpixNormalizer";
import { MATHPIX_OPTIONS_HASH, MATHPIX_TEXT_SOURCE } from "./options";

type ResolveMathpixSelectionInput = {
  parsedPages: Map<number, MathpixParsedPage>;
  selection: SentenceSelection;
};

type ResolvedPageSelection = {
  confidence?: number;
  lineIndexes: number[];
  localContextAfter: string[];
  localContextBefore: string[];
  page: MathpixParsedPage;
  region?: SelectionRegion;
  text: string;
};

const CONTEXT_LINE_COUNT = 3;
const MIN_OVERLAP_SCORE = 0.08;

export function resolveMathpixSelectionText({
  parsedPages,
  selection,
}: ResolveMathpixSelectionInput): SentenceSelection {
  const regions = getSelectionRegions(selection);
  const resolvedRegions = regions
    .map((region) => resolvePageSelection(region, parsedPages.get(region.pageIndex)))
    .filter((resolved): resolved is ResolvedPageSelection => Boolean(resolved));

  if (resolvedRegions.length === 0) {
    return selection;
  }

  const nativeTargetSentence = joinMathpixLines(resolvedRegions.map((resolved) => resolved.text));
  const targetSentence = cleanExtractedText(nativeTargetSentence);
  const normalizedSentence = normalizeSentence(targetSentence);

  if (!normalizedSentence) {
    return selection;
  }

  const mathpixConfidence = getMinConfidence(resolvedRegions);
  const nextRegions = selection.regions
    ? selection.regions.map((region) => {
        const resolved = resolvedRegions.find((item) => item.region === region);

        if (!resolved) {
          return region;
        }

        const nativeRegionSentence = resolved.text;
        const targetRegionSentence = cleanExtractedText(nativeRegionSentence);

        return {
          ...region,
          mathpixConfidence: resolved.confidence,
          mathpixOptionsHash: MATHPIX_OPTIONS_HASH,
          nativeTargetSentence: nativeRegionSentence,
          normalizedSentence: normalizeSentence(targetRegionSentence),
          selectedText: targetRegionSentence,
          targetSentence: targetRegionSentence,
          textSource: MATHPIX_TEXT_SOURCE,
        };
      })
    : selection.regions;

  return {
    ...selection,
    localContextAfter: joinContextLists(resolvedRegions.map((resolved) => resolved.localContextAfter)),
    localContextBefore: joinContextLists(resolvedRegions.map((resolved) => resolved.localContextBefore)),
    mathpixConfidence,
    mathpixOptionsHash: MATHPIX_OPTIONS_HASH,
    nativeTargetSentence,
    normalizedSentence,
    regions: nextRegions,
    selectedText: targetSentence,
    targetSentence,
    textSource: MATHPIX_TEXT_SOURCE,
  };
}

function getSelectionRegions(selection: SentenceSelection) {
  if (selection.regions && selection.regions.length > 0) {
    return selection.regions;
  }

  return [
    {
      normalizedSentence: selection.normalizedSentence,
      pageHeight: selection.pageHeight,
      pageIndex: selection.pageIndex,
      pageWidth: selection.pageWidth,
      rectsOnPage: selection.rectsOnPage,
      selectedText: selection.selectedText,
      targetSentence: selection.targetSentence,
      textSpan: selection.textSpan,
    },
  ];
}

function resolvePageSelection(
  region: SelectionRegion,
  page: MathpixParsedPage | undefined,
): ResolvedPageSelection | undefined {
  if (!page || page.lines.length === 0 || region.rectsOnPage.length === 0) {
    return undefined;
  }

  const selectionRects = region.rectsOnPage.map((rect) => scaleRectToMathpixPage(rect, region, page));
  const matchedLines = page.lines
    .filter((line) => line.region && selectionRects.some((rect) => getOverlapScore(rect, line.region!) >= MIN_OVERLAP_SCORE))
    .sort((left, right) => left.lineIndex - right.lineIndex);

  if (matchedLines.length === 0) {
    return undefined;
  }

  const text = joinMathpixLines(matchedLines.map((line) => line.text));
  const selectedIndexes = matchedLines.map((line) => line.lineIndex);
  const firstLineIndex = Math.min(...selectedIndexes);
  const lastLineIndex = Math.max(...selectedIndexes);

  return {
    confidence: getLineMinConfidence(matchedLines),
    lineIndexes: selectedIndexes,
    localContextAfter: page.lines
      .filter((line) => line.lineIndex > lastLineIndex)
      .slice(0, CONTEXT_LINE_COUNT)
      .map((line) => line.text),
    localContextBefore: page.lines
      .filter((line) => line.lineIndex < firstLineIndex)
      .slice(-CONTEXT_LINE_COUNT)
      .map((line) => line.text),
    page,
    region,
    text,
  };
}

function scaleRectToMathpixPage(
  rect: DOMRectLike,
  region: SelectionRegion,
  page: MathpixParsedPage,
) {
  const scaleX = page.pageWidth && region.pageWidth ? page.pageWidth / region.pageWidth : 1;
  const scaleY = page.pageHeight && region.pageHeight ? page.pageHeight / region.pageHeight : 1;

  return {
    height: rect.height * scaleY,
    width: rect.width * scaleX,
    x: rect.left * scaleX,
    y: rect.top * scaleY,
  };
}

function getOverlapScore(
  selectionRect: { height: number; width: number; x: number; y: number },
  lineRect: { height: number; width: number; x: number; y: number },
) {
  const left = Math.max(selectionRect.x, lineRect.x);
  const right = Math.min(selectionRect.x + selectionRect.width, lineRect.x + lineRect.width);
  const top = Math.max(selectionRect.y, lineRect.y);
  const bottom = Math.min(selectionRect.y + selectionRect.height, lineRect.y + lineRect.height);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);

  if (width <= 0 || height <= 0) {
    return 0;
  }

  const intersectionArea = width * height;
  const selectionArea = Math.max(1, selectionRect.width * selectionRect.height);
  const lineArea = Math.max(1, lineRect.width * lineRect.height);

  return intersectionArea / Math.min(selectionArea, lineArea);
}

function joinContextLists(contextLists: string[][]) {
  return contextLists
    .flatMap((context) => context)
    .map((text) => cleanExtractedText(text))
    .filter(Boolean);
}

function getLineMinConfidence(lines: MathpixParsedLine[]) {
  const confidences = lines
    .flatMap((line) => [line.confidence, line.confidenceRate])
    .filter((value): value is number => typeof value === "number");

  return confidences.length > 0 ? Math.min(...confidences) : undefined;
}

function getMinConfidence(resolvedSelections: ResolvedPageSelection[]) {
  const confidences = resolvedSelections
    .map((selection) => selection.confidence)
    .filter((value): value is number => typeof value === "number");

  return confidences.length > 0 ? Math.min(...confidences) : undefined;
}
