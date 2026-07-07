import { createHash } from "node:crypto";

const DEFAULT_TARGET_TOKENS = 900;
const DEFAULT_OVERLAP_TOKENS = 400;
const MIN_FINAL_CHUNK_TOKENS = 20;

export function createQaChunks({
  chunkerVersion,
  document,
  source,
}) {
  const targetTokens = normalizePositiveInteger(
    process.env.QA_CHUNK_TARGET_TOKENS,
    DEFAULT_TARGET_TOKENS,
  );
  const overlapTokens = Math.min(
    targetTokens - 1,
    normalizePositiveInteger(process.env.QA_CHUNK_OVERLAP_TOKENS, DEFAULT_OVERLAP_TOKENS),
  );
  const units = createChunkUnits(document.pages, targetTokens);
  const chunks = [];
  let currentUnits = [];
  let currentTokenCount = 0;

  for (const unit of units) {
    if (
      currentUnits.length > 0 &&
      currentTokenCount + unit.tokenCount > targetTokens
    ) {
      chunks.push(createChunk({
        chunkerVersion,
        index: chunks.length,
        source,
        title: document.title,
        units: currentUnits,
      }));
      currentUnits = getOverlapUnits(currentUnits, overlapTokens);
      currentTokenCount = sumTokens(currentUnits);
    }

    currentUnits.push(unit);
    currentTokenCount += unit.tokenCount;
  }

  if (currentUnits.length > 0 && currentTokenCount >= MIN_FINAL_CHUNK_TOKENS) {
    chunks.push(createChunk({
      chunkerVersion,
      index: chunks.length,
      source,
      title: document.title,
      units: currentUnits,
    }));
  }

  if (chunks.length === 0 && units.length > 0) {
    chunks.push(createChunk({
      chunkerVersion,
      index: 0,
      source,
      title: document.title,
      units,
    }));
  }

  return chunks;
}

function createChunkUnits(pages, targetTokens) {
  return pages.flatMap((page) => {
    const units = [];
    const pageLatexByLine = Array.isArray(page.latexByLine) ? page.latexByLine : [];
    const pageLineRegions = Array.isArray(page.lineRegions) ? page.lineRegions : [];
    const pageWidth = typeof page.pageWidth === "number" && page.pageWidth > 0 ? page.pageWidth : undefined;
    const pageHeight = typeof page.pageHeight === "number" && page.pageHeight > 0 ? page.pageHeight : undefined;

    page.lines.forEach((line, lineIndex) => {
      const sectionPath = page.sectionsByLine[lineIndex] ?? [];
      const lineLatex = pageLatexByLine[lineIndex];
      const region = pageLineRegions[lineIndex];

      // Normalize the region to 0..1 ratios so the frontend can scale to any
      // render size without knowing the MathPix page dimensions.
      const normalizedRegion = region && pageWidth && pageHeight
        ? {
          height: region.height / pageHeight,
          width: region.width / pageWidth,
          x: region.x / pageWidth,
          y: region.y / pageHeight,
        }
        : undefined;

      splitLongText(line, targetTokens).forEach((text) => {
        const tokenCount = estimateTokenCount(text);

        if (tokenCount > 0) {
          units.push({
            mmd: lineLatex,
            normalizedRegion,
            pageNumber: page.pageNumber,
            sectionPath,
            text,
            tokenCount,
          });
        }
      });
    });

    return units;
  });
}

function splitLongText(text, targetTokens) {
  if (estimateTokenCount(text) <= targetTokens) {
    return [text];
  }

  const sentences = text.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [text];
  const parts = [];
  let current = "";

  for (const sentence of sentences) {
    const next = `${current} ${sentence}`.trim();

    if (current && estimateTokenCount(next) > targetTokens) {
      parts.push(current);
      current = sentence.trim();
    } else {
      current = next;
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts.flatMap((part) => splitByWordsIfNeeded(part, targetTokens));
}

function splitByWordsIfNeeded(text, targetTokens) {
  if (estimateTokenCount(text) <= targetTokens) {
    return [text];
  }

  const words = text.split(/\s+/).filter(Boolean);
  const parts = [];
  let current = [];

  for (const word of words) {
    current.push(word);

    if (estimateTokenCount(current.join(" ")) >= targetTokens) {
      parts.push(current.join(" "));
      current = [];
    }
  }

  if (current.length > 0) {
    parts.push(current.join(" "));
  }

  return parts;
}

function createChunk({ chunkerVersion, index, source, title, units }) {
  const text = units.map((unit) => unit.text).join("\n").trim();
  const pageStart = Math.min(...units.map((unit) => unit.pageNumber));
  const pageEnd = Math.max(...units.map((unit) => unit.pageNumber));
  const sectionPath = getRepresentativeSectionPath(units);
  const tokenCount = estimateTokenCount(text);
  const mmdUnits = units.filter((unit) => unit.mmd);
  const mmd = mmdUnits.length > 0
    ? mmdUnits.map((unit) => unit.mmd).join("\n").trim()
    : undefined;

  // Collect deduplicated normalized line regions so the frontend can draw a
  // highlight box per source line without text-layer matching.
  const seenKeys = new Set();
  const lineRegions = [];
  for (const unit of units) {
    if (!unit.normalizedRegion) {
      continue;
    }

    const key = `${unit.pageNumber}:${unit.normalizedRegion.x}:${unit.normalizedRegion.y}`;
    if (seenKeys.has(key)) {
      continue;
    }

    seenKeys.add(key);
    lineRegions.push({
      pageNumber: unit.pageNumber,
      region: unit.normalizedRegion,
    });
  }

  return {
    chunkHash: createChunkHash({
      chunkerVersion,
      pageEnd,
      pageStart,
      source,
      text,
    }),
    chunkIndex: index,
    lineRegions: lineRegions.length > 0 ? lineRegions : undefined,
    mmd,
    pageEnd,
    pageStart,
    sectionPath,
    text,
    title,
    tokenCount,
  };
}

function getRepresentativeSectionPath(units) {
  for (const unit of units) {
    if (unit.sectionPath.length > 0) {
      return unit.sectionPath;
    }
  }

  return undefined;
}

function getOverlapUnits(units, overlapTokens) {
  const overlap = [];
  let tokenCount = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];

    if (tokenCount + unit.tokenCount > overlapTokens && overlap.length > 0) {
      break;
    }

    overlap.unshift(unit);
    tokenCount += unit.tokenCount;
  }

  return overlap;
}

function createChunkHash(value) {
  return `sha256-${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function sumTokens(units) {
  return units.reduce((total, unit) => total + unit.tokenCount, 0);
}

function estimateTokenCount(value) {
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  const cjkChars = (value.match(/[\u3400-\u9fff]/g) ?? []).length;

  return Math.max(1, Math.ceil(words * 1.3 + cjkChars * 0.6));
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
