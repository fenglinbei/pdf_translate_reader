import katex from "katex";
import { useEffect, useRef, useState } from "react";

type RichMathTextProps = {
  className?: string;
  scale?: number;
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
const MARKDOWN_HEADING_PATTERN = /^[ \t]{0,3}#{1,6}[ \t]+([^\r\n]+?)(?:[ \t]+#+[ \t]*)?(?:\r?\n|$)/;
const OVERFLOW_TOLERANCE_PX = 4;

export function RichMathText({ className, scale, text }: RichMathTextProps) {
  const tokens = tokenizeRichMathText(text);

  return (
    <span
      className={["rich-math-text", className].filter(Boolean).join(" ")}
      style={typeof scale === "number" ? { fontSize: `${scale}em` } : undefined}
    >
      {tokens.map((token, index) => renderToken(token, index, scale))}
    </span>
  );
}

function renderToken(token: RichMathToken, index: number, scale: number | undefined) {
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
    return token.displayMode ? (
      <OverflowAwareSpan
        className="rich-math-text-math-fallback rich-math-text-math-fallback--display"
        key={index}
        measurementKey={scale}
      >
        {token.raw}
      </OverflowAwareSpan>
    ) : (
      <span className="rich-math-text-math-fallback" key={index}>
        {token.raw}
      </span>
    );
  }

  return token.displayMode ? (
    <OverflowAwareSpan
      className="rich-math-text-math rich-math-text-math--display"
      dangerouslySetInnerHTML={{ __html: renderedMath }}
      key={index}
      measurementKey={scale}
    />
  ) : (
    <span
      className="rich-math-text-math"
      dangerouslySetInnerHTML={{ __html: renderedMath }}
      key={index}
    />
  );
}

function OverflowAwareSpan({
  children,
  className,
  dangerouslySetInnerHTML,
  measurementKey,
}: {
  children?: string;
  className: string;
  dangerouslySetInnerHTML?: { __html: string };
  measurementKey?: number;
}) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const element = elementRef.current;

    if (!element) {
      return undefined;
    }

    const updateOverflowState = () => {
      const contentWidth = getContentWidth(element);

      setIsOverflowing(contentWidth > element.clientWidth + OVERFLOW_TOLERANCE_PX);
    };
    const resizeObserver = new ResizeObserver(updateOverflowState);

    updateOverflowState();
    resizeObserver.observe(element);

    return () => {
      resizeObserver.disconnect();
    };
  }, [children, dangerouslySetInnerHTML?.__html, measurementKey]);

  return (
    <span
      className={`${className}${isOverflowing ? " rich-math-text-math--overflowing" : ""}`}
      dangerouslySetInnerHTML={dangerouslySetInnerHTML}
      ref={elementRef}
      tabIndex={isOverflowing ? 0 : undefined}
    >
      {dangerouslySetInnerHTML ? undefined : children}
    </span>
  );
}

function getContentWidth(element: HTMLElement) {
  const renderedMath = element.querySelector<HTMLElement>(".katex-html");

  if (renderedMath) {
    return renderedMath.scrollWidth;
  }

  return element.scrollWidth;
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

  if (match) {
    return {
      end: start + match[0].length,
      text: cleanLatexText(match[2]),
    };
  }

  return readMarkdownHeading(input, start);
}

function readMarkdownHeading(input: string, start: number) {
  if (!isLineStart(input, start)) {
    return undefined;
  }

  const match = MARKDOWN_HEADING_PATTERN.exec(input.slice(start));

  if (!match) {
    return undefined;
  }

  return {
    end: start + match[0].length,
    text: cleanMarkdownText(match[1]),
  };
}

function isLineStart(input: string, start: number) {
  return start === 0 || input[start - 1] === "\n" || input[start - 1] === "\r";
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

function cleanMarkdownText(text: string) {
  return text
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, "$1")
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
