import type {
  MathpixLineRegion,
  MathpixParsedLine,
  MathpixParsedPage,
  PdfLibraryEntry,
} from "../types/domain";
import { MATHPIX_OPTIONS_HASH, MATHPIX_TEXT_SOURCE } from "./options";

type NormalizeMathpixLinesInput = {
  entry: PdfLibraryEntry;
  linesJson: unknown;
};

export function normalizeMathpixLinesJson({
  entry,
  linesJson,
}: NormalizeMathpixLinesInput): MathpixParsedPage[] {
  const rawPages = getRawPages(linesJson);
  const now = Date.now();

  return rawPages
    .map((rawPage, fallbackPageIndex) => {
      const pageObject = asRecord(rawPage);
      const pageIndex = getPageIndex(pageObject, fallbackPageIndex);
      const rawLines = getRawLines(pageObject);
      const lines = rawLines
        .map((rawLine, fallbackLineIndex) => normalizeLine(rawLine, fallbackLineIndex))
        .filter((line): line is MathpixParsedLine => Boolean(line && line.text.trim()));
      const pageText = joinMathpixLines(lines.map((line) => line.text));
      const minConfidence = getMinConfidence(lines);

      return {
        cloudDocumentId: entry.cloudDocumentId,
        lineCount: lines.length,
        lines,
        mathpixOptionsHash: MATHPIX_OPTIONS_HASH,
        minConfidence,
        pageHeight: getOptionalNumber(pageObject.page_height ?? pageObject.pageHeight ?? pageObject.height),
        pageIndex,
        pageMmd: pageText,
        pageText,
        pageWidth: getOptionalNumber(pageObject.page_width ?? pageObject.pageWidth ?? pageObject.width),
        pdfFingerprint: entry.fingerprint,
        source: MATHPIX_TEXT_SOURCE,
        updatedAt: now,
      } satisfies MathpixParsedPage;
    })
    .filter((page) => page.lines.length > 0)
    .sort((left, right) => left.pageIndex - right.pageIndex);
}

function getRawPages(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const object = asRecord(value);
  const pages = object.pages ?? object.page_data ?? object.pageData;

  if (Array.isArray(pages)) {
    return pages;
  }

  const topLevelLines = getRawLines(object);

  if (topLevelLines.length > 0) {
    return groupLinesIntoPages(topLevelLines);
  }

  return [];
}

function groupLinesIntoPages(lines: unknown[]) {
  const pagesByIndex = new Map<number, Record<string, unknown>>();

  lines.forEach((line, fallbackLineIndex) => {
    const lineObject = asRecord(line);
    const pageIndex = getPageIndex(lineObject, 0);
    const pageObject = pagesByIndex.get(pageIndex) ?? {
      lines: [],
      page: pageIndex + 1,
      page_height: lineObject.page_height ?? lineObject.pageHeight,
      page_width: lineObject.page_width ?? lineObject.pageWidth,
    };
    const pageLines = Array.isArray(pageObject.lines) ? pageObject.lines : [];

    pageLines.push({
      line: fallbackLineIndex,
      ...lineObject,
    });
    pageObject.lines = pageLines;
    pagesByIndex.set(pageIndex, pageObject);
  });

  return Array.from(pagesByIndex.entries())
    .sort(([leftPageIndex], [rightPageIndex]) => leftPageIndex - rightPageIndex)
    .map(([, page]) => page);
}

function getRawLines(pageObject: Record<string, unknown>) {
  const lines = pageObject.lines ?? pageObject.line_data ?? pageObject.lineData ?? pageObject.children;

  return Array.isArray(lines) ? lines : [];
}

function normalizeLine(rawLine: unknown, fallbackLineIndex: number): MathpixParsedLine | undefined {
  const lineObject = asRecord(rawLine);
  const text = cleanLineText(
    lineObject.text_display ??
      lineObject.textDisplay ??
      lineObject.text ??
      lineObject.value ??
      lineObject.latex_styled ??
      lineObject.latex,
  );

  if (!text) {
    return undefined;
  }

  return {
    confidence: getOptionalNumber(lineObject.confidence),
    confidenceRate: getOptionalNumber(lineObject.confidence_rate ?? lineObject.confidenceRate),
    cnt: normalizeCnt(lineObject.cnt),
    isHandwritten: getOptionalBoolean(lineObject.is_handwritten ?? lineObject.isHandwritten),
    isPrinted: getOptionalBoolean(lineObject.is_printed ?? lineObject.isPrinted),
    lineIndex: getOptionalNumber(lineObject.line ?? lineObject.line_index ?? lineObject.lineIndex) ?? fallbackLineIndex,
    region: normalizeRegion(lineObject.region, lineObject.cnt),
    text,
  };
}

function getPageIndex(pageObject: Record<string, unknown>, fallbackPageIndex: number) {
  const pageIndex = getOptionalNumber(pageObject.page_index ?? pageObject.pageIndex);

  if (typeof pageIndex === "number") {
    return Math.max(0, Math.floor(pageIndex));
  }

  const pageNumber = getOptionalNumber(pageObject.page ?? pageObject.page_number ?? pageObject.pageNumber);

  if (typeof pageNumber === "number") {
    return Math.max(0, Math.floor(pageNumber) - 1);
  }

  return fallbackPageIndex;
}

function normalizeRegion(
  rawRegion: unknown,
  rawCnt: unknown,
): MathpixLineRegion | undefined {
  const region = asRecord(rawRegion);
  const x = getOptionalNumber(region.x ?? region.left);
  const y = getOptionalNumber(region.y ?? region.top);
  const width = getOptionalNumber(region.width ?? region.w);
  const height = getOptionalNumber(region.height ?? region.h);

  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
  ) {
    return { height, width, x, y };
  }

  const cnt = normalizeCnt(rawCnt);

  if (!cnt || cnt.length === 0) {
    return undefined;
  }

  const xs = cnt.map(([pointX]) => pointX);
  const ys = cnt.map(([, pointY]) => pointY);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);

  return {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  };
}

function normalizeCnt(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const points: Array<[number, number]> = [];

  for (const rawPoint of value) {
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) {
      continue;
    }

    const x = getOptionalNumber(rawPoint[0]);
    const y = getOptionalNumber(rawPoint[1]);

    if (typeof x === "number" && typeof y === "number") {
      points.push([x, y]);
    }
  }

  return points.length > 0 ? points : undefined;
}

function cleanLineText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function joinMathpixLines(lines: string[]) {
  const parts: string[] = [];

  for (const line of lines) {
    const text = cleanLineText(line);

    if (!text) {
      continue;
    }

    const previous = parts[parts.length - 1];

    if (!previous) {
      parts.push(text);
    } else if (isDisplayMath(previous) || isDisplayMath(text)) {
      parts.push("\n", text);
    } else {
      parts.push(" ", text);
    }
  }

  return parts.join("").replace(/[ \t]+\n/g, "\n").trim();
}

function isDisplayMath(text: string) {
  const trimmed = text.trim();

  return (
    trimmed.startsWith("\\[") ||
    trimmed.endsWith("\\]") ||
    trimmed.startsWith("$$") ||
    trimmed.endsWith("$$") ||
    /^\\begin\{(?:equation|align|aligned|gather|gathered|array|cases)\*?\}/.test(trimmed)
  );
}

function getMinConfidence(lines: MathpixParsedLine[]) {
  const confidences = lines
    .flatMap((line) => [line.confidence, line.confidenceRate])
    .filter((value): value is number => typeof value === "number");

  if (confidences.length === 0) {
    return undefined;
  }

  return Math.min(...confidences);
}

function getOptionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
