export type NormalizedPageText = {
  normalizedToRaw: number[];
  rawToNormalized: number[];
  text: string;
};

export type SentenceRange = {
  end: number;
  index: number;
  normalized: string;
  start: number;
  text: string;
};

const COMMON_ABBREVIATIONS = new Set([
  "al",
  "dr",
  "e.g",
  "eq",
  "etc",
  "fig",
  "i.e",
  "mr",
  "mrs",
  "ms",
  "prof",
  "vs",
]);

export function normalizePageText(rawText: string): NormalizedPageText {
  const rawToNormalized = new Array<number>(rawText.length + 1);
  const normalizedToRaw: number[] = [];
  const output: string[] = [];
  let rawIndex = 0;

  while (rawIndex < rawText.length) {
    rawToNormalized[rawIndex] = output.length;

    if (shouldRemoveHyphenatedBreak(rawText, rawIndex)) {
      rawToNormalized[rawIndex] = output.length;
      rawIndex += 1;

      while (rawIndex < rawText.length && isWhitespace(rawText[rawIndex])) {
        rawToNormalized[rawIndex] = output.length;
        rawIndex += 1;
      }

      continue;
    }

    if (isWhitespace(rawText[rawIndex])) {
      const whitespaceStart = rawIndex;

      while (rawIndex < rawText.length && isWhitespace(rawText[rawIndex])) {
        rawToNormalized[rawIndex] = output.length;
        rawIndex += 1;
      }

      if (output.length > 0 && rawIndex < rawText.length && output[output.length - 1] !== " ") {
        output.push(" ");
        normalizedToRaw.push(whitespaceStart);
      }

      continue;
    }

    output.push(rawText[rawIndex]);
    normalizedToRaw.push(rawIndex);
    rawIndex += 1;
  }

  if (output[output.length - 1] === " ") {
    output.pop();
    normalizedToRaw.pop();
  }

  rawToNormalized[rawText.length] = output.length;
  fillMissingRawMappings(rawToNormalized);

  return {
    normalizedToRaw,
    rawToNormalized,
    text: output.join(""),
  };
}

export function findSentenceRanges(text: string): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let sentenceStart = 0;
  let index = 0;

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (!isSentenceTerminator(text[cursor]) || isLikelyAbbreviation(text, cursor)) {
      continue;
    }

    let sentenceEnd = cursor + 1;

    while (sentenceEnd < text.length && isClosingPunctuation(text[sentenceEnd])) {
      sentenceEnd += 1;
    }

    const nextIndex = skipSpaces(text, sentenceEnd);

    if (nextIndex < text.length && !looksLikeSentenceStart(text[nextIndex])) {
      continue;
    }

    const range = createSentenceRange(text, sentenceStart, sentenceEnd, index);

    if (range) {
      ranges.push(range);
      index += 1;
    }

    sentenceStart = skipSpaces(text, sentenceEnd);
    cursor = sentenceStart - 1;
  }

  const tailRange = createSentenceRange(text, sentenceStart, text.length, index);

  if (tailRange) {
    ranges.push(tailRange);
  }

  return ranges;
}

export function findSentenceForRange(
  sentences: SentenceRange[],
  selectionStart: number,
  selectionEnd: number,
) {
  if (sentences.length === 0) {
    return undefined;
  }

  const midpoint = selectionStart + Math.max(0, selectionEnd - selectionStart) / 2;

  return (
    sentences.find((sentence) => midpoint >= sentence.start && midpoint <= sentence.end) ??
    sentences.find((sentence) => selectionStart < sentence.end && selectionEnd > sentence.start)
  );
}

export function normalizeSentence(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function createSentenceRange(
  text: string,
  rawStart: number,
  rawEnd: number,
  index: number,
): SentenceRange | undefined {
  const start = skipSpaces(text, rawStart);
  let end = rawEnd;

  while (end > start && isWhitespace(text[end - 1])) {
    end -= 1;
  }

  if (start >= end) {
    return undefined;
  }

  const sentenceText = text.slice(start, end);

  return {
    end,
    index,
    normalized: normalizeSentence(sentenceText),
    start,
    text: sentenceText,
  };
}

function shouldRemoveHyphenatedBreak(text: string, index: number) {
  if (text[index] !== "-" || index === 0 || !isAsciiLetter(text[index - 1])) {
    return false;
  }

  let cursor = index + 1;
  let sawLineBreak = false;

  while (cursor < text.length && isWhitespace(text[cursor])) {
    sawLineBreak ||= text[cursor] === "\n" || text[cursor] === "\r";
    cursor += 1;
  }

  return sawLineBreak && cursor < text.length && isAsciiLetter(text[cursor]);
}

function isLikelyAbbreviation(text: string, terminatorIndex: number) {
  if (text[terminatorIndex] !== ".") {
    return false;
  }

  const before = text.slice(Math.max(0, terminatorIndex - 12), terminatorIndex).toLowerCase();
  const match = before.match(/[a-z](?:[a-z]|\.)*$/);

  return !!match && COMMON_ABBREVIATIONS.has(match[0]);
}

function fillMissingRawMappings(rawToNormalized: number[]) {
  let latest = 0;

  for (let index = 0; index < rawToNormalized.length; index += 1) {
    if (typeof rawToNormalized[index] === "number") {
      latest = rawToNormalized[index];
    } else {
      rawToNormalized[index] = latest;
    }
  }
}

function skipSpaces(text: string, index: number) {
  let cursor = index;

  while (cursor < text.length && isWhitespace(text[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function isAsciiLetter(character: string) {
  return /^[A-Za-z]$/.test(character);
}

function isClosingPunctuation(character: string) {
  return /["')\]}”’»]/.test(character);
}

function isSentenceTerminator(character: string) {
  return /[.!?。！？]/.test(character);
}

function isWhitespace(character: string) {
  return /\s/.test(character);
}

function looksLikeSentenceStart(character: string) {
  return /[A-Z0-9"'([{“‘¿¡一-龥]/.test(character);
}
