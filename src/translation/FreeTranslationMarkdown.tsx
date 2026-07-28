import katex from "katex";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import texmath from "markdown-it-texmath";
import { useMemo } from "react";

// markdown-it-texmath 1.0.0 restricts \begin{...} names to lowercase
// letters, excluding common KaTeX environments such as equation*, align*,
// gather*, and CD. Keep the package's parser/rendering pipeline, but widen its
// public beg_end rule before registering the plugin.
const beginEndRule = texmath.rules.beg_end.block[0];
if (beginEndRule) {
  beginEndRule.rex =
    /(\\(?:begin)\{([A-Za-z]+\*?)\}[\s\S]+?\\(?:end)\{\2\})/gmy;
}

const freeTranslationMarkdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
})
  .use(footnote)
  .use(taskLists, {
    enabled: false,
    label: false,
  })
  .use(texmath, {
    delimiters: ["dollars", "brackets", "beg_end"],
    engine: katex,
    katexOptions: {
      output: "htmlAndMathml",
      strict: "warn",
      throwOnError: false,
      trust: false,
    },
  });

// markdown-it-texmath's block rules do not advertise themselves as paragraph
// terminators. Without this silent rule, a display formula directly following
// prose is swallowed by the preceding paragraph unless the model inserts a
// blank line. The texmath rules still own parsing and rendering; this rule only
// lets markdown-it stop the paragraph at a supported block-math opener.
freeTranslationMarkdown.block.ruler.before(
  "paragraph",
  "texmath_paragraph_terminator",
  (state, startLine, _endLine, silent) => {
    if (!silent) {
      return false;
    }

    const start = state.bMarks[startLine] + state.tShift[startLine];
    const line = state.src.slice(start, state.eMarks[startLine]);

    return line.startsWith("\\[")
      || line.startsWith("$$")
      || /^\\begin\{[A-Za-z]+\*?\}/.test(line);
  },
  { alt: ["paragraph"] },
);

const renderLinkOpen = freeTranslationMarkdown.renderer.rules.link_open;

freeTranslationMarkdown.renderer.rules.link_open = (
  tokens,
  index,
  options,
  environment,
  renderer,
) => {
  const token = tokens[index];
  token.attrSet("rel", "noreferrer noopener");
  token.attrSet("target", "_blank");

  return renderLinkOpen
    ? renderLinkOpen(tokens, index, options, environment, renderer)
    : renderer.renderToken(tokens, index, options);
};

export function renderFreeTranslationMarkdown(text: string) {
  return freeTranslationMarkdown.render(text);
}

export function FreeTranslationMarkdown({ text }: { text: string }) {
  const markup = useMemo(() => renderFreeTranslationMarkdown(text), [text]);

  return (
    <div
      className="free-translation-markdown"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}

export function FreeTranslationResultContent({
  rendered,
  text,
}: {
  rendered: boolean;
  text: string;
}) {
  return rendered ? (
    <FreeTranslationMarkdown text={text} />
  ) : (
    <pre className="free-translation-raw-output">{text}</pre>
  );
}
