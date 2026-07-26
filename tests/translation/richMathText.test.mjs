import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { TRANSLATION_PROMPT_VERSION as SERVER_TRANSLATION_PROMPT_VERSION } from "../../server/deepseek/prompt.mjs";

let RichMathText;
let translationDefaults;
let tokenizeRichMathText;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  [
    { RichMathText, tokenizeRichMathText },
    translationDefaults,
  ] = await Promise.all([
    vite.ssrLoadModule("/src/translation/RichMathText.tsx"),
    vite.ssrLoadModule("/src/translation/defaults.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

describe("RichMathText Mathpix list rendering", () => {
  it("keeps the client and server selection prompt versions aligned", () => {
    assert.equal(
      translationDefaults.TRANSLATION_PROMPT_VERSION,
      SERVER_TRANSLATION_PROMPT_VERSION,
    );
  });

  it("parses consecutive itemize environments with custom and empty markers", () => {
    const text = String.raw`计算实验 \begin{itemize} \item[4.1.] 本文是否包含计算实验？(yes/no) 在此处输入您的回复 \end{itemize} 若是，请回应以下几点：\begin{itemize} \item[4.2.] 本文说明了参数范围 \item[] 以及用于选择最终参数设置的标准 \item[4.3.] 数据预处理代码已包含 \end{itemize}`;
    const tokens = tokenizeRichMathText(text);

    assert.deepEqual(tokens.map((token) => token.kind), [
      "text",
      "list",
      "text",
      "list",
    ]);
    assert.equal(tokens[1].environment, "itemize");
    assert.equal(tokens[1].items[0].customMarker, true);
    assert.equal(tokens[1].items[0].marker[0].text, "4.1.");
    assert.equal(tokens[3].items.length, 3);
    assert.equal(tokens[3].items[1].customMarker, true);
    assert.deepEqual(tokens[3].items[1].marker, []);
    assert.match(tokens[3].items[1].content[0].text, /选择最终参数设置/);
  });

  it("supports nested list environments while keeping inline math renderable", () => {
    const text = String.raw`\begin{enumerate}
\item Outer \(x^2\)
\begin{itemize}
\item[] Nested continuation
\item Nested default marker
\end{itemize}
\end{enumerate}`;
    const [list] = tokenizeRichMathText(text);
    const nestedList = list.items[0].content.find((token) => token.kind === "list");

    assert.equal(list.kind, "list");
    assert.equal(list.environment, "enumerate");
    assert.ok(list.items[0].content.some((token) => token.kind === "math"));
    assert.equal(nestedList?.environment, "itemize");
    assert.equal(nestedList?.items[0].customMarker, true);
    assert.deepEqual(nestedList?.items[0].marker, []);
  });

  it("renders semantic lists instead of exposing Mathpix control sequences", () => {
    const text = String.raw`\begin{itemize}\item[4.1.] First \(\alpha\)\item[] continuation\end{itemize}`;
    const markup = renderToStaticMarkup(React.createElement(RichMathText, { text }));

    assert.match(markup, /<ul class="rich-math-text-list rich-math-text-list--itemize">/);
    assert.match(markup, /rich-math-text-list-marker/);
    assert.match(markup, /katex/);
    assert.doesNotMatch(markup, /\\begin\{itemize}/);
    assert.doesNotMatch(markup, /\\item/);
  });

  it("keeps malformed environments visible instead of dropping content", () => {
    const text = String.raw`Before \begin{itemize}\item Unclosed`;
    const tokens = tokenizeRichMathText(text);

    assert.deepEqual(tokens.map((token) => token.kind), ["text"]);
    assert.equal(tokens[0].text, text);
  });
});
