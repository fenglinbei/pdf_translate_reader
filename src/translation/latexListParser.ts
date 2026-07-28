import { KATEX_DISPLAY_ENVIRONMENTS } from "./latexMathEnvironments";
import { LATEX_TEXT_COMMAND_NAMES } from "./latexTextCommands";

export type LatexListEnvironment = "description" | "enumerate" | "itemize";

export type LatexListItem = {
  content: string;
  customMarker: boolean;
  marker: string;
};

export type LatexListMatch = {
  end: number;
  environment: LatexListEnvironment;
  items: LatexListItem[];
};

export type LatexListSegment =
  | {
      kind: "list";
      list: LatexListMatch;
    }
  | {
      kind: "text";
      text: string;
    };

export type LatexListLocation = {
  list: LatexListMatch;
  start: number;
};

const LIST_BEGIN_PATTERN =
  /^\\begin\s*\{\s*(description|enumerate|itemize)\s*\}/;
const LIST_ITEM_PATTERN = /^\\item(?![A-Za-z@])/;
const ENVIRONMENT_BEGIN_PATTERN =
  /^\\begin\s*\{\s*([A-Za-z@][A-Za-z0-9@*:_-]*)\s*\}/;
const ENVIRONMENT_END_PATTERN =
  /^\\end\s*\{\s*([A-Za-z@][A-Za-z0-9@*:_-]*)\s*\}/;
const VERBATIM_BEGIN_PATTERN =
  /^\\begin\s*\{\s*(Verbatim|lstlisting|minted|verbatim\*?)\s*\}/;
const DISPLAY_ENVIRONMENT_SET = new Set<string>(KATEX_DISPLAY_ENVIRONMENTS);
const LATEX_TEXT_COMMAND_PATTERN = new RegExp(
  `^\\\\(?:${[...LATEX_TEXT_COMMAND_NAMES]
    .sort((left, right) => right.length - left.length)
    .join("|")})(?![A-Za-z@])\\s*\\{`,
);

export function readLatexListEnvironment(
  input: string,
  start: number,
): LatexListMatch | undefined {
  if (
    start < 0
    || start >= input.length
    || input[start] !== "\\"
    || isEscaped(input, start)
    || findContainingProtectedEnd(input, start) !== undefined
  ) {
    return undefined;
  }

  return parseLatexListEnvironment(input, start);
}

export function splitLatexListSegments(input: string): LatexListSegment[] {
  const segments: LatexListSegment[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < input.length) {
    const protectedEnd = readProtectedEnd(input, cursor);

    if (protectedEnd !== undefined) {
      cursor = protectedEnd;
      continue;
    }

    if (input[cursor] === "\\" && !isEscaped(input, cursor)) {
      const list = parseLatexListEnvironment(input, cursor);

      if (list) {
        if (cursor > textStart) {
          segments.push({
            kind: "text",
            text: input.slice(textStart, cursor),
          });
        }

        segments.push({ kind: "list", list });
        cursor = list.end;
        textStart = cursor;
        continue;
      }
    }

    cursor += 1;
  }

  if (textStart < input.length) {
    segments.push({
      kind: "text",
      text: input.slice(textStart),
    });
  }

  return segments;
}

export function findLatexListEnvironment(
  input: string,
  start: number,
  searchEnd: number,
): LatexListLocation | undefined {
  let cursor = start;
  const boundedEnd = Math.min(searchEnd, input.length);

  while (cursor < boundedEnd) {
    const protectedEnd = readProtectedEnd(input, cursor);

    if (protectedEnd !== undefined) {
      cursor = protectedEnd;
      continue;
    }

    if (input[cursor] === "\\" && !isEscaped(input, cursor)) {
      const list = parseLatexListEnvironment(input, cursor);

      if (list) {
        const containingProtectedEnd = findContainingProtectedEnd(input, cursor);

        if (containingProtectedEnd !== undefined) {
          cursor = containingProtectedEnd;
          continue;
        }

        return { list, start: cursor };
      }
    }

    cursor += 1;
  }

  return undefined;
}

function parseLatexListEnvironment(
  input: string,
  start: number,
): LatexListMatch | undefined {
  const openMatch = LIST_BEGIN_PATTERN.exec(input.slice(start));

  if (!openMatch) {
    return undefined;
  }

  const environment = openMatch[1] as LatexListEnvironment;
  let bodyStart = start + openMatch[0].length;
  const environmentOption = readOptionalArgumentAfterWhitespace(input, bodyStart);

  if (environmentOption) {
    bodyStart = environmentOption.end;
  }

  const environmentStack: string[] = [environment];
  const itemStarts: Array<{
    commandStart: number;
    contentStart: number;
    customMarker: boolean;
    marker: string;
  }> = [];
  let cursor = bodyStart;

  while (cursor < input.length) {
    const protectedEnd = readProtectedEnd(input, cursor);

    if (protectedEnd !== undefined) {
      cursor = protectedEnd;
      continue;
    }

    if (input[cursor] !== "\\" || isEscaped(input, cursor)) {
      cursor += 1;
      continue;
    }

    const remaining = input.slice(cursor);
    const nestedOpenMatch = ENVIRONMENT_BEGIN_PATTERN.exec(remaining);

    if (nestedOpenMatch) {
      environmentStack.push(nestedOpenMatch[1]);
      cursor += nestedOpenMatch[0].length;
      const nestedOption = readOptionalArgumentAfterWhitespace(input, cursor);
      cursor = nestedOption?.end ?? cursor;
      continue;
    }

    const closeMatch = ENVIRONMENT_END_PATTERN.exec(remaining);

    if (closeMatch) {
      const closingEnvironment = closeMatch[1];

      if (environmentStack[environmentStack.length - 1] !== closingEnvironment) {
        return undefined;
      }

      environmentStack.pop();

      if (environmentStack.length === 0) {
        if (itemStarts.length === 0) {
          return undefined;
        }

        const closingStart = cursor;
        const leadingContent = input
          .slice(bodyStart, itemStarts[0].commandStart)
          .trim();
        const items = itemStarts.map((item, itemIndex) => {
          const contentEnd =
            itemStarts[itemIndex + 1]?.commandStart ?? closingStart;
          const itemContent = input.slice(item.contentStart, contentEnd).trim();

          return {
            content:
              itemIndex === 0 && leadingContent
                ? [leadingContent, itemContent].filter(Boolean).join(" ")
                : itemContent,
            customMarker: item.customMarker,
            marker: item.marker,
          };
        });

        return {
          end: cursor + closeMatch[0].length,
          environment,
          items,
        };
      }

      cursor += closeMatch[0].length;
      continue;
    }

    const itemMatch = LIST_ITEM_PATTERN.exec(remaining);

    if (itemMatch) {
      const commandEnd = cursor + itemMatch[0].length;
      const header = readListItemHeader(input, commandEnd);

      if (environmentStack.length === 1) {
        itemStarts.push({
          commandStart: cursor,
          contentStart: header.contentStart,
          customMarker: header.customMarker,
          marker: header.marker,
        });
      }

      cursor = header.contentStart;
      continue;
    }

    cursor += 1;
  }

  return undefined;
}

function readListItemHeader(input: string, commandEnd: number) {
  let cursor = skipWhitespace(input, commandEnd);

  if (input[cursor] !== "[") {
    return {
      contentStart: cursor,
      customMarker: false,
      marker: "",
    };
  }

  const marker = readBracketArgument(input, cursor);

  if (!marker) {
    return {
      contentStart: cursor,
      customMarker: false,
      marker: "",
    };
  }

  if (input[marker.end] === "(") {
    return {
      contentStart: cursor,
      customMarker: false,
      marker: "",
    };
  }

  cursor = skipWhitespace(input, marker.end);

  return {
    contentStart: cursor,
    customMarker: true,
    marker: marker.body.trim(),
  };
}

function readOptionalArgumentAfterWhitespace(input: string, start: number) {
  const argumentStart = skipWhitespace(input, start);

  if (input[argumentStart] !== "[") {
    return undefined;
  }

  return readBracketArgument(input, argumentStart);
}

function readBracketArgument(input: string, openingBracketIndex: number) {
  let depth = 0;

  for (let index = openingBracketIndex; index < input.length; index += 1) {
    const literalEnd = readLiteralSpanEnd(input, index);

    if (literalEnd !== undefined) {
      index = literalEnd - 1;
      continue;
    }

    const character = input[index];

    if (isEscaped(input, index)) {
      continue;
    }

    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;

      if (depth === 0) {
        return {
          body: input.slice(openingBracketIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readBraceArgument(input: string, openingBraceIndex: number) {
  let depth = 0;

  for (let index = openingBraceIndex; index < input.length; index += 1) {
    const literalEnd = readLiteralSpanEnd(input, index);

    if (literalEnd !== undefined) {
      index = literalEnd - 1;
      continue;
    }

    if (isEscaped(input, index)) {
      continue;
    }

    if (input[index] === "{") {
      depth += 1;
    } else if (input[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return {
          body: input.slice(openingBraceIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  return undefined;
}

function readLiteralSpanEnd(input: string, start: number) {
  if (input[start] === "`" && !isEscaped(input, start)) {
    const markerLength = countRepeatedCharacter(input, start, "`");
    const marker = "`".repeat(markerLength);
    const closingStart = input.indexOf(marker, start + markerLength);

    return closingStart < 0
      ? undefined
      : closingStart + markerLength;
  }

  if (
    input[start] !== "\\"
    || isEscaped(input, start)
    || !input.startsWith("\\verb", start)
  ) {
    return undefined;
  }

  const verbMatch = /^\\verb\*?([^\sA-Za-z])/.exec(input.slice(start));

  if (!verbMatch) {
    return undefined;
  }

  const closingStart = input.indexOf(
    verbMatch[1],
    start + verbMatch[0].length,
  );

  return closingStart < 0 ? input.length : closingStart + 1;
}

function findContainingProtectedEnd(input: string, target: number) {
  let cursor = 0;

  while (cursor < target) {
    const protectedEnd = readProtectedEnd(input, cursor);

    if (protectedEnd !== undefined) {
      if (protectedEnd > target) {
        return protectedEnd;
      }

      cursor = protectedEnd;
      continue;
    }

    cursor += 1;
  }

  return undefined;
}

function readProtectedEnd(input: string, start: number): number | undefined {
  const character = input[start];

  if (character === "`" && !isEscaped(input, start)) {
    const markerLength = countRepeatedCharacter(input, start, "`");
    const marker = "`".repeat(markerLength);
    const closingStart = input.indexOf(marker, start + markerLength);

    return closingStart < 0
      ? undefined
      : closingStart + markerLength;
  }

  if (
    character === "%"
    && !isEscaped(input, start)
    && (start === 0 || /\s/.test(input[start - 1]))
  ) {
    const lineEnd = input.indexOf("\n", start + 1);
    return lineEnd < 0 ? input.length : lineEnd + 1;
  }

  if (character === "$" && !isEscaped(input, start)) {
    const markerLength = input[start + 1] === "$" ? 2 : 1;
    const closingStart = findUnescapedSequence(
      input,
      "$".repeat(markerLength),
      start + markerLength,
    );

    return closingStart < 0
      ? undefined
      : closingStart + markerLength;
  }

  if (character !== "\\" || isEscaped(input, start)) {
    return undefined;
  }

  const verbMatch = /^\\verb\*?([^\sA-Za-z])/.exec(input.slice(start));

  if (verbMatch) {
    const delimiter = verbMatch[1];
    const closingStart = input.indexOf(delimiter, start + verbMatch[0].length);
    return closingStart < 0 ? input.length : closingStart + 1;
  }

  const textCommandMatch = LATEX_TEXT_COMMAND_PATTERN.exec(input.slice(start));

  if (textCommandMatch) {
    const argument = readBraceArgument(
      input,
      start + textCommandMatch[0].length - 1,
    );

    return argument?.end ?? input.length;
  }

  const bracketMathClose = input.startsWith("\\(", start)
    ? "\\)"
    : input.startsWith("\\[", start)
      ? "\\]"
      : undefined;

  if (bracketMathClose) {
    const bracketMathEnd = findUnescapedSequence(
      input,
      bracketMathClose,
      start + 2,
    );

    return bracketMathEnd < 0 ? input.length : bracketMathEnd + 2;
  }

  const verbatimMatch = VERBATIM_BEGIN_PATTERN.exec(input.slice(start));

  if (verbatimMatch) {
    return findEnvironmentEnd(
      input,
      start + verbatimMatch[0].length,
      verbatimMatch[1],
    );
  }

  const displayEnvironmentMatch =
    /^\\begin\{([A-Za-z]+\*?)\}/.exec(input.slice(start));

  if (
    displayEnvironmentMatch
    && DISPLAY_ENVIRONMENT_SET.has(displayEnvironmentMatch[1])
  ) {
    return findEnvironmentEnd(
      input,
      start + displayEnvironmentMatch[0].length,
      displayEnvironmentMatch[1],
    );
  }

  return undefined;
}

function findEnvironmentEnd(input: string, start: number, environment: string) {
  const closingCommand = `\\end{${environment}}`;
  const closingStart = findUnescapedSequence(input, closingCommand, start);

  return closingStart < 0
    ? input.length
    : closingStart + closingCommand.length;
}

function findUnescapedSequence(
  input: string,
  sequence: string,
  start: number,
) {
  let candidate = input.indexOf(sequence, start);

  while (candidate >= 0 && isEscaped(input, candidate)) {
    candidate = input.indexOf(sequence, candidate + sequence.length);
  }

  return candidate;
}

function countRepeatedCharacter(
  input: string,
  start: number,
  character: string,
) {
  let cursor = start;

  while (input[cursor] === character) {
    cursor += 1;
  }

  return cursor - start;
}

function skipWhitespace(input: string, start: number) {
  let cursor = start;

  while (cursor < input.length && /\s/.test(input[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function isEscaped(input: string, index: number) {
  let backslashCount = 0;

  for (
    let cursor = index - 1;
    cursor >= 0 && input[cursor] === "\\";
    cursor -= 1
  ) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}
