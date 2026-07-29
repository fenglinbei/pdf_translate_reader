const DEFAULT_MAX_INCOMPLETE_UNIT_CHARACTERS = 3_600;

const STEP_LINE_PATTERN =
  /^(?:#{1,6}\s+|[-*+]\s+|(?:\d+|[一二三四五六七八九十]+)[.)、]\s*)/u;
const TRANSITION_PATTERN =
  /^(?:(?:接下来|然后|但是|不过|因此|所以|最后|进一步|另一方面|随后|再来|现在|需要|还要)|(?:next|then|however|therefore|finally|further|another|now|also)\b)/iu;

export function createReasoningSegmenter({
  maxIncompleteUnitCharacters = DEFAULT_MAX_INCOMPLETE_UNIT_CHARACTERS,
} = {}) {
  const normalizedMaximum = Math.max(
    512,
    Math.round(maxIncompleteUnitCharacters),
  );
  let incompleteTail = "";
  let tailStartOffset = 0;
  let unitSequence = 0;

  function push(value) {
    if (typeof value !== "string" || value.length === 0) {
      return [];
    }

    incompleteTail += value;
    const units = [];

    while (incompleteTail.length > 0) {
      const semanticBoundary = findNextSemanticBoundary(incompleteTail);
      const boundary = semanticBoundary ?? (
        incompleteTail.length > normalizedMaximum
          ? createForcedBoundary(incompleteTail, normalizedMaximum)
          : undefined
      );

      if (!boundary) {
        break;
      }

      const rawUnit = incompleteTail.slice(0, boundary.endOffset);
      const text = rawUnit.trim();
      const startOffset = tailStartOffset;
      const endOffset = tailStartOffset + boundary.endOffset;

      incompleteTail = incompleteTail.slice(boundary.endOffset);
      tailStartOffset = endOffset;

      if (!text) {
        continue;
      }

      units.push({
        boundary: boundary.type,
        endOffset,
        id: `reasoning-unit-${++unitSequence}`,
        startOffset,
        text,
        transition: TRANSITION_PATTERN.test(text),
      });
    }

    return units;
  }

  function discard() {
    incompleteTail = "";
  }

  function snapshot() {
    return {
      incompleteCharacters: incompleteTail.length,
      nextOffset: tailStartOffset + incompleteTail.length,
      unitCount: unitSequence,
    };
  }

  return {
    discard,
    push,
    snapshot,
  };
}

function findNextSemanticBoundary(value) {
  let environmentDepth = 0;
  let fencedCodeMarker;
  let inlineCode = false;
  let mathDelimiter;
  let lineStart = true;
  let pendingFenceBoundary = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (lineStart && !inlineCode && !mathDelimiter && environmentDepth === 0) {
      const fence = value.slice(index).match(/^[ \t]*(```+|~~~+)/);

      if (fence) {
        const marker = fence[1][0];

        if (!fencedCodeMarker) {
          fencedCodeMarker = marker;
        } else if (fencedCodeMarker === marker) {
          fencedCodeMarker = undefined;
          pendingFenceBoundary = true;
        }

        index += fence[0].length - 1;
        lineStart = false;
        continue;
      }
    }

    if (character === "\n") {
      lineStart = true;

      if (pendingFenceBoundary) {
        return {
          endOffset: index + 1,
          type: "step",
        };
      }

      if (fencedCodeMarker || inlineCode || mathDelimiter || environmentDepth > 0) {
        continue;
      }

      const nextContentOffset = skipHorizontalWhitespace(value, index + 1);

      if (value[nextContentOffset] === "\n") {
        return {
          endOffset: skipParagraphWhitespace(value, nextContentOffset + 1),
          type: "paragraph",
        };
      }

      const currentLineStart = value.lastIndexOf("\n", index - 1) + 1;
      const currentLine = value.slice(currentLineStart, index).trim();
      const nextLine = value.slice(nextContentOffset).split(/\r?\n/, 1)[0];

      if (
        STEP_LINE_PATTERN.test(currentLine) ||
        STEP_LINE_PATTERN.test(nextLine)
      ) {
        return {
          endOffset: index + 1,
          type: "step",
        };
      }

      continue;
    }

    lineStart = false;

    if (fencedCodeMarker || isEscaped(value, index)) {
      continue;
    }

    if (value.startsWith("\\begin{", index)) {
      environmentDepth += 1;
      continue;
    }

    if (value.startsWith("\\end{", index) && environmentDepth > 0) {
      environmentDepth -= 1;
      continue;
    }

    if (environmentDepth > 0) {
      continue;
    }

    if (character === "`" && !mathDelimiter) {
      inlineCode = !inlineCode;
      continue;
    }

    if (inlineCode) {
      continue;
    }

    if (character === "$") {
      const delimiter = value[index + 1] === "$" ? "$$" : "$";

      if (!mathDelimiter) {
        mathDelimiter = delimiter;
      } else if (mathDelimiter === delimiter) {
        mathDelimiter = undefined;
      }

      if (delimiter === "$$") {
        index += 1;
      }
      continue;
    }

    if (mathDelimiter || !isSentenceTerminator(value, index)) {
      continue;
    }

    let endOffset = consumeSentenceClosingCharacters(value, index + 1);
    const paragraphOffset = skipHorizontalWhitespace(value, endOffset);

    if (value[paragraphOffset] === "\n") {
      const nextContentOffset = skipHorizontalWhitespace(
        value,
        paragraphOffset + 1,
      );

      if (value[nextContentOffset] === "\n") {
        return {
          endOffset: skipParagraphWhitespace(value, nextContentOffset + 1),
          type: "paragraph",
        };
      }
    }

    endOffset = skipHorizontalWhitespace(value, endOffset);

    return {
      endOffset,
      type: "sentence",
    };
  }

  return undefined;
}

function createForcedBoundary(value, maximum) {
  const minimum = Math.floor(maximum * 0.7);
  let endOffset = maximum;

  for (let index = maximum; index >= minimum; index -= 1) {
    if (/\s/u.test(value[index])) {
      endOffset = index + 1;
      break;
    }
  }

  return {
    endOffset,
    type: "forced",
  };
}

function isSentenceTerminator(value, index) {
  const character = value[index];

  if (/[。！？!?；;]/u.test(character)) {
    return true;
  }

  if (character !== ".") {
    return false;
  }

  const previous = value[index - 1];
  const next = value[index + 1];
  const lineStart = value.lastIndexOf("\n", index - 1) + 1;
  const beforePeriod = value.slice(lineStart, index).trim();

  if (next === undefined) {
    return false;
  }

  if (/\d/u.test(previous ?? "") && /\d/u.test(next ?? "")) {
    return false;
  }

  if (/^\d+$/u.test(beforePeriod) && /\s/u.test(next ?? "")) {
    return false;
  }

  return /[\s"'”’）)\]}]/u.test(next);
}

function consumeSentenceClosingCharacters(value, startOffset) {
  let offset = startOffset;

  while (
    offset < value.length &&
    /[。！？!?；;."'”’）)\]}]/u.test(value[offset])
  ) {
    offset += 1;
  }

  return offset;
}

function skipHorizontalWhitespace(value, startOffset) {
  let offset = startOffset;

  while (offset < value.length && /[ \t\r]/u.test(value[offset])) {
    offset += 1;
  }

  return offset;
}

function skipParagraphWhitespace(value, startOffset) {
  let offset = startOffset;

  while (offset < value.length && /\s/u.test(value[offset])) {
    offset += 1;
  }

  return offset;
}

function isEscaped(value, index) {
  let slashCount = 0;

  for (let offset = index - 1; offset >= 0 && value[offset] === "\\"; offset -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}
