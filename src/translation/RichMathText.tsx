import katex from "katex";

type RichMathTextProps = {
  className?: string;
  text: string;
};

type RichMathToken =
  | {
      kind: "heading";
      text: string;
    }
  | {
      displayMode: boolean;
      kind: "math";
      raw: string;
      text: string;
    }
  | {
      kind: "text";
      text: string;
    };

const DISPLAY_ENVIRONMENTS = [
  "align",
  "align*",
  "alignat",
  "alignat*",
  "equation",
  "equation*",
  "gather",
  "gather*",
  "multline",
  "multline*",
];
const HEADING_PATTERN = /^\\(section|subsection|subsubsection|paragraph)\*?\{([^{}]*)\}\s*/;

export function RichMathText({ className, text }: RichMathTextProps) {
  const tokens = tokenizeRichMathText(text);

  return (
    <span className={["rich-math-text", className].filter(Boolean).join(" ")}>
      {tokens.map((token, index) => renderToken(token, index))}
    </span>
  );
}

function renderToken(token: RichMathToken, index: number) {
  if (token.kind === "text") {
    return token.text ? <span key={index}>{token.text}</span> : null;
  }

  if (token.kind === "heading") {
    return (
      <span className="rich-math-text-heading" key={index}>
        {token.text}
      </span>
    );
  }

  const renderedMath = renderMath(token.text, token.displayMode);

  if (!renderedMath) {
    return (
      <span
        className={
          token.displayMode
            ? "rich-math-text-math-fallback rich-math-text-math-fallback--display"
            : "rich-math-text-math-fallback"
        }
        key={index}
      >
        {token.raw}
      </span>
    );
  }

  return (
    <span
      className={token.displayMode ? "rich-math-text-math rich-math-text-math--display" : "rich-math-text-math"}
      dangerouslySetInnerHTML={{ __html: renderedMath }}
      key={index}
    />
  );
}

function tokenizeRichMathText(input: string): RichMathToken[] {
  const tokens: RichMathToken[] = [];
  let textBuffer = "";
  let index = 0;

  function flushTextBuffer() {
    if (textBuffer) {
      tokens.push({ kind: "text", text: textBuffer });
      textBuffer = "";
    }
  }

  while (index < input.length) {
    const heading = readHeading(input, index);

    if (heading) {
      flushTextBuffer();
      tokens.push({ kind: "heading", text: heading.text });
      index = heading.end;
      continue;
    }

    const displayMath =
      readDelimitedMath(input, index, "\\[", "\\]", true) ??
      readDelimitedMath(input, index, "$$", "$$", true) ??
      readDisplayEnvironment(input, index);

    if (displayMath) {
      flushTextBuffer();
      tokens.push(displayMath);
      index = displayMath.end;
      continue;
    }

    const inlineMath = readDelimitedMath(input, index, "\\(", "\\)", false);

    if (inlineMath) {
      flushTextBuffer();
      tokens.push(inlineMath);
      index = inlineMath.end;
      continue;
    }

    textBuffer += input[index];
    index += 1;
  }

  flushTextBuffer();

  return mergeAdjacentTextTokens(tokens);
}

function readHeading(input: string, start: number) {
  const match = HEADING_PATTERN.exec(input.slice(start));

  if (!match) {
    return undefined;
  }

  return {
    end: start + match[0].length,
    text: cleanLatexText(match[2]),
  };
}

function readDelimitedMath(
  input: string,
  start: number,
  open: string,
  close: string,
  displayMode: boolean,
) {
  if (!input.startsWith(open, start)) {
    return undefined;
  }

  const contentStart = start + open.length;
  const contentEnd = input.indexOf(close, contentStart);

  if (contentEnd < 0) {
    return undefined;
  }

  const end = contentEnd + close.length;
  const text = input.slice(contentStart, contentEnd).trim();

  if (!text) {
    return undefined;
  }

  return {
    displayMode,
    end,
    kind: "math" as const,
    raw: input.slice(start, end),
    text,
  };
}

function readDisplayEnvironment(input: string, start: number) {
  const environment = DISPLAY_ENVIRONMENTS.find((candidate) =>
    input.startsWith(`\\begin{${candidate}}`, start)
  );

  if (!environment) {
    return undefined;
  }

  const close = `\\end{${environment}}`;
  const contentEnd = input.indexOf(close, start + environment.length + 8);

  if (contentEnd < 0) {
    return undefined;
  }

  const end = contentEnd + close.length;

  return {
    displayMode: true,
    end,
    kind: "math" as const,
    raw: input.slice(start, end),
    text: input.slice(start, end).trim(),
  };
}

function renderMath(source: string, displayMode: boolean) {
  try {
    return katex.renderToString(source, {
      displayMode,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
  } catch {
    return undefined;
  }
}

function cleanLatexText(text: string) {
  return text
    .replace(/\\&/g, "&")
    .replace(/\\%/g, "%")
    .replace(/\\_/g, "_")
    .replace(/\\#/g, "#")
    .replace(/\\\$/g, "$")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeAdjacentTextTokens(tokens: RichMathToken[]) {
  const mergedTokens: RichMathToken[] = [];

  for (const token of tokens) {
    const previousToken = mergedTokens[mergedTokens.length - 1];

    if (token.kind === "text" && previousToken?.kind === "text") {
      previousToken.text += token.text;
    } else {
      mergedTokens.push(token);
    }
  }

  return mergedTokens;
}
