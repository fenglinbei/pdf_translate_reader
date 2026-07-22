import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeTranslationLanguagePair } from "../../server/deepseek/languages.mjs";
import {
  buildTranslationMessages,
  FREE_TRANSLATION_MAX_SOURCE_CHARS,
  FREE_TRANSLATION_PROMPT_VERSION,
  getTranslationPromptVersion,
  TRANSLATION_PROMPT_VERSION,
} from "../../server/deepseek/prompt.mjs";

describe("translation prompts", () => {
  it("keeps selection translation on the translation-v3 prompt behavior", () => {
    const messages = buildTranslationMessages(createRequest({
      requestKind: "selection",
      targetSentence: "First line\n\nSecond line",
    }));

    assert.equal(TRANSLATION_PROMPT_VERSION, "translation-v3");
    assert.equal(getTranslationPromptVersion("selection"), "translation-v3");
    assert.match(messages[0].content, /Only translate the target sentence/);
    assert.match(messages[0].content, /Do not add commentary, explanation, markdown/);
    assert.match(messages[1].content, /Target sentence:\nFirst line Second line\n/);
    assert.doesNotMatch(messages[0].content, /professional document translator/);
  });

  it("uses a dedicated free-translation prompt and preserves structured source text verbatim", () => {
    const sourceText = [
      "# Paper title",
      "",
      "- First **important** item",
      "- Formula:",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "| Metric | Value |",
      "| --- | ---: |",
      "| F1 | 0.92 |",
      "",
      "```ts",
      "const benchmarkId = \"demo-v1\";",
      "```",
    ].join("\n");
    const messages = buildTranslationMessages(createRequest({
      requestKind: "free",
      targetSentence: sourceText,
    }));

    assert.equal(FREE_TRANSLATION_PROMPT_VERSION, "free-translation-v1");
    assert.equal(getTranslationPromptVersion("free"), "free-translation-v1");
    assert.match(messages[0].content, /Markdown and GitHub Flavored Markdown structure/);
    assert.match(messages[0].content, /Preserve LaTeX delimiters/);
    assert.match(messages[0].content, /Preserve paragraph boundaries, blank lines, and line breaks/);
    assert.equal(extractFreeSourceDocument(messages[1].content), sourceText);
    assert.doesNotMatch(messages[0].content, /Only translate the target sentence/);
  });

  it("keeps all 20,000 allowed free-translation characters without truncation", () => {
    const structuredSuffix = "\n\n## Formula\n\n$$x^2 + y^2$$";
    const sourceText = `${"文".repeat(FREE_TRANSLATION_MAX_SOURCE_CHARS - structuredSuffix.length)}${structuredSuffix}`;
    const messages = buildTranslationMessages(createRequest({
      requestKind: "free",
      targetSentence: sourceText,
    }));

    assert.equal(sourceText.length, 20_000);
    assert.equal(extractFreeSourceDocument(messages[1].content), sourceText);
  });

  it("rejects free-translation input over the hard limit instead of truncating it", () => {
    const sourceText = "a".repeat(FREE_TRANSLATION_MAX_SOURCE_CHARS + 1);

    assert.throws(
      () => buildTranslationMessages(createRequest({
        requestKind: "free",
        targetSentence: sourceText,
      })),
      /must be 20000 characters or fewer \(received 20001\)/,
    );
  });

  it("allows auto source detection only when explicitly enabled for free translation", () => {
    assert.deepEqual(
      normalizeTranslationLanguagePair("AUTO", "zh", { allowAutoSource: true }),
      { sourceLang: "auto", targetLang: "zh" },
    );
    assert.throws(
      () => normalizeTranslationLanguagePair("auto", "zh"),
      /Unsupported sourceLang: auto/,
    );
    assert.throws(
      () => normalizeTranslationLanguagePair("en", "auto", { allowAutoSource: true }),
      /Unsupported targetLang: auto/,
    );
  });

  it("tells the free prompt to auto-detect its source language", () => {
    const messages = buildTranslationMessages(createRequest({
      requestKind: "free",
      sourceLang: "auto",
    }));

    assert.match(messages[0].content, /Auto-detect the source language/);
    assert.match(messages[1].content, /Source language: auto-detect from the source document/);
  });
});

function createRequest(overrides = {}) {
  return {
    localContextAfter: ["Following context."],
    localContextBefore: ["Previous context."],
    longContextEnabled: true,
    paperContext: {
      abstract: "An abstract.",
      terminology: [{ source: "benchmark", target: "基准" }],
      title: "A title",
    },
    requestKind: "selection",
    sourceLang: "en",
    targetLang: "zh",
    targetSentence: "Hello",
    translationStyle: { presetId: "academic-faithful" },
    ...overrides,
  };
}

function extractFreeSourceDocument(userPrompt) {
  const startMarker = "--- BEGIN SOURCE DOCUMENT ---\n";
  const endMarker = "\n--- END SOURCE DOCUMENT ---";
  const start = userPrompt.indexOf(startMarker);
  const end = userPrompt.lastIndexOf(endMarker);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return userPrompt.slice(start + startMarker.length, end);
}
