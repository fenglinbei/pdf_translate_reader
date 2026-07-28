import type MarkdownIt from "markdown-it";
import {
  LATEX_TEXT_COMMAND_NAMES,
  type LatexTextCommand,
} from "./latexTextCommands";

type LatexTextCommandDefinition = {
  className: string;
  literal?: boolean;
  tag: "code" | "em" | "s" | "span" | "strong" | "sub" | "sup";
};

const LATEX_TEXT_COMMANDS: Record<
  LatexTextCommand,
  LatexTextCommandDefinition
> = {
  em: {
    className: "free-translation-latex-text--emphasis",
    tag: "em",
  },
  emph: {
    className: "free-translation-latex-text--emphasis",
    tag: "em",
  },
  mbox: {
    className: "free-translation-latex-text--mbox",
    tag: "span",
  },
  sout: {
    className: "free-translation-latex-text--strike",
    tag: "s",
  },
  text: {
    className: "free-translation-latex-text--text",
    tag: "span",
  },
  textbf: {
    className: "free-translation-latex-text--bold",
    tag: "strong",
  },
  textit: {
    className: "free-translation-latex-text--italic",
    tag: "em",
  },
  textmd: {
    className: "free-translation-latex-text--medium",
    tag: "span",
  },
  textnormal: {
    className: "free-translation-latex-text--normal",
    tag: "span",
  },
  textrm: {
    className: "free-translation-latex-text--roman",
    tag: "span",
  },
  textsc: {
    className: "free-translation-latex-text--small-caps",
    tag: "span",
  },
  textsf: {
    className: "free-translation-latex-text--sans-serif",
    tag: "span",
  },
  textsl: {
    className: "free-translation-latex-text--slanted",
    tag: "em",
  },
  textsubscript: {
    className: "free-translation-latex-text--subscript",
    tag: "sub",
  },
  textsuperscript: {
    className: "free-translation-latex-text--superscript",
    tag: "sup",
  },
  texttt: {
    className: "free-translation-latex-text--monospace",
    literal: true,
    tag: "code",
  },
  textup: {
    className: "free-translation-latex-text--upright",
    tag: "span",
  },
  underline: {
    className: "free-translation-latex-text--underline",
    tag: "span",
  },
};

const LATEX_TEXT_COMMAND_PATTERN = new RegExp(
  `^\\\\(${[...LATEX_TEXT_COMMAND_NAMES]
    .sort((left, right) => right.length - left.length)
    .join("|")})(?![A-Za-z@])\\s*`,
);

export function markdownItLatexText(md: MarkdownIt) {
  md.inline.ruler.before("escape", "latex_verb", (state, silent) => {
    if (!state.src.startsWith("\\verb", state.pos)) {
      return false;
    }

    const match = /^\\verb\*?([^\sA-Za-z])/.exec(state.src.slice(state.pos));

    if (!match) {
      return false;
    }

    const contentStart = state.pos + match[0].length;
    const contentEnd = state.src.indexOf(match[1], contentStart);

    if (contentEnd < 0) {
      return false;
    }

    if (!silent) {
      const token = state.push("code_inline", "code", 0);
      token.content = state.src.slice(contentStart, contentEnd);
      token.markup = match[0].slice(0, -1);
    }

    state.pos = contentEnd + 1;
    return true;
  });

  md.inline.ruler.before("escape", "latex_text_command", (state, silent) => {
    if (state.src[state.pos] !== "\\") {
      return false;
    }

    const commandMatch = LATEX_TEXT_COMMAND_PATTERN.exec(
      state.src.slice(state.pos),
    );

    if (!commandMatch) {
      return false;
    }

    const argumentStart = state.pos + commandMatch[0].length;

    if (state.src[argumentStart] !== "{") {
      return false;
    }

    const argument = readBraceArgument(state.src, argumentStart);

    if (!argument) {
      return false;
    }

    if (!silent) {
      const token = state.push("latex_text_command", "", 0);
      const command = commandMatch[1] as LatexTextCommand;
      token.meta = {
        argument: argument.body,
        command,
      };
      token.children = [];

      if (!LATEX_TEXT_COMMANDS[command].literal) {
        state.md.inline.parse(
          argument.body,
          state.md,
          state.env,
          token.children,
        );
      }
    }

    state.pos = argument.end;
    return true;
  });

  md.renderer.rules.latex_text_command = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const {
      argument,
      command,
    } = tokens[index].meta as {
      argument: string;
      command: LatexTextCommand;
    };
    const definition = LATEX_TEXT_COMMANDS[command];
    const content = definition.literal
      ? md.utils.escapeHtml(argument)
      : renderer.renderInline(
        tokens[index].children ?? [],
        options,
        environment,
      );

    return `<${definition.tag} class="free-translation-latex-text ${definition.className}">${content}</${definition.tag}>`;
  };
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
    let markerEnd = start;

    while (input[markerEnd] === "`") {
      markerEnd += 1;
    }

    const marker = input.slice(start, markerEnd);
    const closingStart = input.indexOf(marker, markerEnd);

    return closingStart < 0
      ? undefined
      : closingStart + marker.length;
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
