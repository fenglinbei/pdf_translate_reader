import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createServer } from "vite";

let renderFreeTranslationMarkdown;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ renderFreeTranslationMarkdown } = await vite.ssrLoadModule(
    "/src/translation/FreeTranslationMarkdown.tsx",
  ));
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
});
