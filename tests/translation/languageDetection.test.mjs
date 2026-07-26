import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectTranslationSourceLanguage,
} from "../../server/translationModels/languageDetection.mjs";

describe("free-translation source language detection", () => {
  for (const [language, text] of [
    ["en", "Hello world. This is an English research paper about energy."],
    ["fr", "Bonjour, cette étude est une analyse de la qualité et des résultats."],
    ["de", "Hallo, diese Studie ist eine Analyse der Qualität und der Ergebnisse."],
    ["es", "Hola, este estudio es un análisis de la calidad y los resultados."],
    ["ja", "この研究では、エネルギー保存則を詳しく分析します。"],
    ["ko", "이 연구에서는 에너지 보존 법칙을 자세히 분석합니다."],
    ["zh", "这项研究分析了能源系统的质量与效率。"],
    ["zh-Hant", "這項研究分析了能源系統的品質與效率。"],
  ]) {
    it(`detects ${language}`, () => {
      const result = detectTranslationSourceLanguage(text);

      assert.equal(result?.language, language);
      assert.equal(result?.source, "local");
      assert.ok(result.confidence >= 0 && result.confidence <= 1);
    });
  }

  it("ignores fenced code, inline code, URLs, and LaTeX-only input", () => {
    const result = detectTranslationSourceLanguage([
      "```ts",
      "const hello = 'world';",
      "```",
      "`the world`",
      "https://example.com/the-world",
      String.raw`\alpha + \beta = \gamma`,
      "$E = mc^2$",
    ].join("\n"));

    assert.equal(result, undefined);
  });

  it("does not guess when Latin-language evidence is ambiguous", () => {
    assert.equal(detectTranslationSourceLanguage("de la"), undefined);
    assert.equal(detectTranslationSourceLanguage("energy model"), undefined);
    assert.equal(detectTranslationSourceLanguage("12345"), undefined);
  });

  it("detects short Japanese with one kana and leaves pure Han text unresolved", () => {
    assert.equal(detectTranslationSourceLanguage("東京へ")?.language, "ja");
    assert.equal(detectTranslationSourceLanguage("日本語"), undefined);
    assert.equal(detectTranslationSourceLanguage("質量"), undefined);
  });
});
