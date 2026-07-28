import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let FreeTranslationResultContent;
let renderFreeTranslationMarkdown;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    FreeTranslationResultContent,
    renderFreeTranslationMarkdown,
  } = await vite.ssrLoadModule("/src/translation/FreeTranslationMarkdown.tsx"));
});

after(async () => {
  await vite?.close();
});

describe("free translation Markdown rendering", () => {
  it("renders dollar, bracket, and equation environment math", () => {
    const source = String.raw`The mapper annotates each pair as
\[
M(u_j,a_i)=(r_{ij},d_{ij},c_{ij}),
\]
where \(c_{ij}\in[0,1]\) and $r_{ij}\in\{\text{support},\text{refute}\}$.

\begin{equation}
H'=F\!\left(H,M(u,\mathcal A)\right).
\end{equation}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /class="katex-display"/);
    assert.match(markup, /class="katex"/);
    assert.match(markup, /application\/x-tex/);
    assert.doesNotMatch(markup, /\\\[|\\\]|\\\(|\\\)/);
    assert.doesNotMatch(markup, /<p>\\begin\{equation\}/);
  });

  it("renders supported multi-line environments without wrapping them in dollars", () => {
    const source = String.raw`\begin{align}
x &= y + 1 \\
z &= x - 1
\end{align}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /class="katex-display"/);
    assert.doesNotMatch(markup, /<p>\\begin\{align\}/);
  });

  it("renders starred and uppercase KaTeX environments", () => {
    const source = String.raw`A starred equation follows
\begin{equation*}
E = mc^2
\end{equation*}

\begin{align*}
x &= y + 1 \\
z &= x - 1
\end{align*}

An uppercase environment follows
\begin{CD}
A @>>> B
\end{CD}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.equal((markup.match(/class="katex-display"/g) ?? []).length, 3);
    assert.doesNotMatch(markup, /<p>\\begin\{(?:equation|align)\*\}/);
    assert.doesNotMatch(markup, /<p>\\begin\{CD\}/);
  });

  it("renders single-line LaTeX itemize output as a semantic list", () => {
    const source = String.raw`\begin{itemize} \item 我们提出了 \textbf{EviTrace}，一个用于自动化事实验证的新颖框架。 \item 我们设计了一个受分治范式启发的自回归证据组织器。 \item 我们在跨域事实验证基准上取得了新的最先进性能。 \end{itemize}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(
      markup,
      /<ul class="free-translation-latex-list free-translation-latex-list--itemize">/,
    );
    assert.equal(
      (markup.match(/class="free-translation-latex-list-item"/g) ?? []).length,
      3,
    );
    assert.match(
      markup,
      /<strong class="free-translation-latex-text free-translation-latex-text--bold">EviTrace<\/strong>/,
    );
    assert.doesNotMatch(markup, /katex-error/);
    assert.doesNotMatch(markup, /\\begin\{itemize\}|\\item|\\textbf/);
  });

  it("supports enumerate, description labels, options, and nested lists", () => {
    const source = String.raw`前文 \begin{enumerate}[label=\alph*.]
\item First \(x^2\)
\item Second
\begin{itemize}
\item[] Nested continuation
\item Nested default marker
\end{itemize}
\end{enumerate} 后文

\begin{description}
\item[\textbf{模型}] EviTrace
\item[] Empty label
\end{description}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /<p>前文<\/p>/);
    assert.match(
      markup,
      /<ol class="free-translation-latex-list free-translation-latex-list--enumerate">/,
    );
    assert.match(
      markup,
      /<ul class="free-translation-latex-list free-translation-latex-list--itemize">/,
    );
    assert.match(
      markup,
      /<dl class="free-translation-latex-list free-translation-latex-list--description">/,
    );
    assert.match(markup, /free-translation-latex-description-term--empty/);
    assert.match(markup, /class="katex"/);
    assert.match(markup, /<p>后文<\/p>/);
    assert.doesNotMatch(markup, /label=|\\alph|katex-error/);
  });

  it("keeps paragraphs and display math inside multi-line list items", () => {
    const source = String.raw`\begin{itemize}
\item First paragraph

Second paragraph with \emph{emphasis}.
\item Formula:
\[
H'=F(H,M).
\]
\end{itemize}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /<p>First paragraph<\/p>/);
    assert.match(
      markup,
      /<p>Second paragraph with <em class="free-translation-latex-text free-translation-latex-text--emphasis">emphasis<\/em>\.<\/p>/,
    );
    assert.match(markup, /class="katex-display"/);
    assert.equal(
      (markup.match(/class="free-translation-latex-list-item"/g) ?? []).length,
      2,
    );
  });

  it("renders a multi-line LaTeX list cleanly inside a Markdown blockquote", () => {
    const source = String.raw`> \begin{itemize}
> \item First
> \item Second
> \end{itemize}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.equal((markup.match(/<blockquote>/g) ?? []).length, 1);
    assert.match(markup, /<blockquote>\s*<ul[\s\S]*<\/ul>\s*<\/blockquote>/);
    assert.equal(
      (markup.match(/class="free-translation-latex-list-item"/g) ?? []).length,
      2,
    );
  });

  it("renders common LaTeX text commands, including nesting and empty arguments", () => {
    const source = String.raw`\textbf{EviTrace \emph{framework} \textnormal{normal}} \emph{italic \textup{up}} \emph{} \textit{italic} \underline{underlined} \texttt{<tag>} \textsuperscript{2} \mbox{no break}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(
      markup,
      /<strong class="free-translation-latex-text free-translation-latex-text--bold">EviTrace <em class="free-translation-latex-text free-translation-latex-text--emphasis">framework<\/em> <span class="free-translation-latex-text free-translation-latex-text--normal">normal<\/span><\/strong>/,
    );
    assert.match(
      markup,
      /<em class="free-translation-latex-text free-translation-latex-text--emphasis"><\/em>/,
    );
    assert.match(markup, /free-translation-latex-text--underline/);
    assert.match(
      markup,
      /<code class="free-translation-latex-text free-translation-latex-text--monospace">&lt;tag&gt;<\/code>/,
    );
    assert.match(markup, /free-translation-latex-text--superscript/);
    assert.match(markup, /free-translation-latex-text--upright/);
    assert.match(markup, /free-translation-latex-text--mbox/);
    assert.doesNotMatch(markup, /\\textbf|\\emph|\\textit|\\underline/);
  });

  it("balances formatting arguments around Markdown code and verb spans", () => {
    const source = [
      "\\textbf{before `}` after}",
      "\\textbf{before `{` after}",
      String.raw`\textbf{before \verb|}| after}`,
    ].join(" ");
    const markup = renderFreeTranslationMarkdown(source);

    assert.equal(
      (markup.match(/free-translation-latex-text--bold/g) ?? []).length,
      3,
    );
    assert.match(markup, /before <code>}<\/code> after/);
    assert.match(markup, /before <code>{<\/code> after/);
  });

  it("ignores item commands inside formatting, comments, and nested environments", () => {
    const source = [
      String.raw`\begin{enumerate}`,
      String.raw`\item \texttt{\item literal}`,
      String.raw`\begin{quote}`,
      String.raw`\item not an outer item`,
      String.raw`\end{quote}`,
      String.raw`% \item comment text`,
      "still first",
      "\\item[`]`] second",
      String.raw`\end{enumerate}`,
    ].join("\n");
    const markup = renderFreeTranslationMarkdown(source);

    assert.equal(
      (markup.match(/class="free-translation-latex-list-item(?: |")/g) ?? [])
        .length,
      2,
    );
    assert.match(markup, /<code[^>]*>\\item literal<\/code>/);
    assert.match(markup, /<code>]<\/code>/);
    assert.doesNotMatch(markup, /katex-error/);
  });

  it("does not interpret LaTeX structures inside code, verb, or escaped commands", () => {
    const source = [
      String.raw`\begin{itemize}\item inline code\end{itemize}`,
      "",
      [
        "`multi-line code",
        String.raw`\begin{enumerate}\item still code\end{enumerate}`,
        "ends here`",
      ].join("\n"),
      "",
      String.raw`\begin{itemize}
\item \verb|\item stays literal|
\item second
\end{itemize}`,
      "",
      String.raw`\\textbf{escaped} and \textbf{rendered}`,
    ].join("\n");
    const sourceWithInlineCode = source.replace(
      String.raw`\begin{itemize}\item inline code\end{itemize}`,
      [
        "`",
        String.raw`\begin{itemize}\item inline code\end{itemize}`,
        "`",
      ].join(""),
    );
    const markup = renderFreeTranslationMarkdown(sourceWithInlineCode);

    assert.match(
      markup,
      /<code>\\begin\{itemize\}\\item inline code\\end\{itemize\}<\/code>/,
    );
    assert.match(
      markup,
      /<code>multi-line code \\begin\{enumerate\}\\item still code\\end\{enumerate\} ends here<\/code>/,
    );
    assert.match(markup, /<code>\\item stays literal<\/code>/);
    assert.equal(
      (markup.match(/class="free-translation-latex-list-item"/g) ?? []).length,
      2,
    );
    assert.match(markup, /\\textbf\{escaped\}/);
    assert.equal(
      (markup.match(/free-translation-latex-text--bold/g) ?? []).length,
      1,
    );
  });

  it("keeps unsupported or malformed environments visible without KaTeX errors", () => {
    const source = String.raw`\begin{quote}Quoted\end{quote}

\begin{itemize}\item Unclosed

\begin{itemize}\item Mismatched\end{enumerate}

\begin{itemize}\end{itemize}`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /\\begin\{quote\}Quoted\\end\{quote\}/);
    assert.match(markup, /\\begin\{itemize\}\\item Unclosed/);
    assert.match(markup, /\\end\{enumerate\}/);
    assert.match(markup, /\\begin\{itemize\}\\end\{itemize\}/);
    assert.doesNotMatch(markup, /free-translation-latex-list/);
    assert.doesNotMatch(markup, /katex-error/);
  });

  it("keeps list rendering subject to the existing HTML and URL safety policy", () => {
    const markup = renderFreeTranslationMarkdown(
      String.raw`\begin{itemize}\item <script>alert("unsafe")</script> [unsafe](javascript:alert(1))\end{itemize}`,
    );

    assert.match(markup, /free-translation-latex-list/);
    assert.match(markup, /&lt;script&gt;/);
    assert.doesNotMatch(markup, /<script>|href="javascript:/);
  });

  it("keeps Markdown links, natural percentages, and escaped backticks compatible", () => {
    const source = [
      "准确率为 95%",
      "escaped \\` before",
      String.raw`\begin{itemize}\item [Paper](https://example.com)\item Next\end{itemize}`,
      "escaped \\` after",
    ].join(" ");
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /free-translation-latex-list--itemize/);
    assert.match(
      markup,
      /<a href="https:\/\/example\.com" rel="noreferrer noopener" target="_blank">Paper<\/a>/,
    );
    assert.doesNotMatch(
      markup,
      /free-translation-latex-list-item--custom-marker/,
    );
    assert.match(markup, /95%/);
    assert.match(markup, /escaped ` before/);
    assert.match(markup, /escaped ` after/);
  });

  it("places list-item footnotes once at the end of the rendered result", () => {
    const source = String.raw`\begin{itemize}\item \textbf{First[^note]}\item Second\end{itemize}

[^note]: Footnote content`;
    const markup = renderFreeTranslationMarkdown(source);
    const listEnd = markup.indexOf("</ul>");
    const footnotesStart = markup.indexOf('<section class="footnotes">');

    assert.ok(listEnd >= 0);
    assert.ok(footnotesStart > listEnd);
    assert.equal(
      (markup.match(/<section class="footnotes">/g) ?? []).length,
      1,
    );
    assert.equal((markup.match(/id="fn1"/g) ?? []).length, 1);
    assert.match(
      markup,
      /<strong class="free-translation-latex-text free-translation-latex-text--bold">First<sup class="footnote-ref">[\s\S]*?<\/sup><\/strong>/,
    );
    assert.match(markup, /Footnote content/);
  });

  it("preserves GFM tables, task lists, footnotes, links, and fenced code", () => {
    const source = `| Item | Value |
| --- | ---: |
| Formula | \\(x^2\\) |

- [x] rendered

[Documentation](https://example.com)[^1]

\`\`\`tex
\\[this must stay source code\\]
\\begin{equation}
not rendered
\\end{equation}
\`\`\`

[^1]: Footnote`;
    const markup = renderFreeTranslationMarkdown(source);

    assert.match(markup, /<table>/);
    assert.match(markup, /task-list-item-checkbox/);
    assert.match(markup, /class="footnote-ref"/);
    assert.match(markup, /class="footnotes"/);
    assert.match(
      markup,
      /<a href="https:\/\/example\.com" rel="noreferrer noopener" target="_blank">/,
    );
    assert.match(markup, /<code class="language-tex">/);
    assert.match(markup, /\\\[this must stay source code\\\]/);
    assert.match(markup, /\\begin\{equation\}/);
    assert.equal((markup.match(/class="katex"/g) ?? []).length, 1);
  });

  it("escapes raw HTML and rejects unsafe link protocols", () => {
    const markup = renderFreeTranslationMarkdown(
      `<script>alert("unsafe")</script>\n\n[unsafe](javascript:alert(1))`,
    );

    assert.doesNotMatch(markup, /<script>/);
    assert.match(markup, /&lt;script&gt;/);
    assert.doesNotMatch(markup, /href="javascript:/);
  });

  it("keeps incomplete streamed delimiters visible until they close", () => {
    const markup = renderFreeTranslationMarkdown(
      String.raw`Pending \(\alpha and \begin{equation} x = 1`,
    );

    assert.doesNotMatch(markup, /class="katex"/);
    assert.match(markup, /Pending/);
    assert.match(markup, /begin\{equation\}/);
  });

  it("shows the original Markdown and LaTeX safely in unrendered mode", () => {
    const source = String.raw`# Heading

\[
E = mc^2
\]

<script>alert("unsafe")</script>`;
    const markup = renderToStaticMarkup(
      React.createElement(FreeTranslationResultContent, {
        rendered: false,
        text: source,
      }),
    );

    assert.match(markup, /class="free-translation-raw-output"/);
    assert.match(markup, /# Heading/);
    assert.match(markup, /\\\[/);
    assert.match(markup, /\\\]/);
    assert.match(markup, /&lt;script&gt;alert/);
    assert.doesNotMatch(markup, /class="katex"/);
    assert.doesNotMatch(markup, /<script>/);
  });

  it("uses the Markdown renderer when rendered mode is enabled", () => {
    const markup = renderToStaticMarkup(
      React.createElement(FreeTranslationResultContent, {
        rendered: true,
        text: String.raw`\[E = mc^2\]`,
      }),
    );

    assert.match(markup, /class="free-translation-markdown"/);
    assert.match(markup, /class="katex-display"/);
    assert.doesNotMatch(markup, /free-translation-raw-output/);
  });
});
