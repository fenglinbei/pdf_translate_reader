import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let swap;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  swap = await vite.ssrLoadModule(
    "/src/translation/freeTranslationSwap.ts",
  );
});

after(async () => {
  await vite?.close();
});

function createInput(overrides = {}) {
  return {
    busy: false,
    detectedSourceLang: undefined,
    hasFreshCompletedTranslation: false,
    maxSourceCharacters: 20_000,
    sourceLang: "en",
    sourceText: "Hello",
    targetLang: "zh",
    translation: "",
    ...overrides,
  };
}

test("moves a fresh completed translation into the source pane and swaps explicit languages", () => {
  const translation = "# 标题\n\n公式 $E = mc^2$";
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    hasFreshCompletedTranslation: true,
    translation,
  }));

  assert.deepEqual(plan, {
    enabled: true,
    movesTranslation: true,
    next: {
      sourceLang: "zh",
      sourceText: translation,
      targetLang: "en",
    },
    reason: "move-translation",
  });
});

test("allows explicit languages to swap without a fresh result", () => {
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    sourceText: "Current edited source",
    translation: "Stale or partial result",
  }));

  assert.deepEqual(plan, {
    enabled: true,
    movesTranslation: false,
    next: {
      sourceLang: "zh",
      sourceText: "Current edited source",
      targetLang: "en",
    },
    reason: "swap-languages",
  });
});

test("uses the detected language as the reverse target for auto detection", () => {
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    detectedSourceLang: "de",
    hasFreshCompletedTranslation: true,
    sourceLang: "auto",
    sourceText: "Guten Tag",
    translation: "你好",
  }));

  assert.deepEqual(plan, {
    enabled: true,
    movesTranslation: true,
    next: {
      sourceLang: "zh",
      sourceText: "你好",
      targetLang: "de",
    },
    reason: "move-translation",
  });
});

test("disables auto detection when the detected source language is unavailable", () => {
  const input = createInput({
    hasFreshCompletedTranslation: true,
    sourceLang: "auto",
    translation: "你好",
  });
  const plan = swap.createFreeTranslationSwapPlan(input);

  assert.deepEqual(plan, {
    enabled: false,
    movesTranslation: false,
    next: {
      sourceLang: "auto",
      sourceText: "Hello",
      targetLang: "zh",
    },
    reason: "auto-source-unresolved",
  });
});

test("does not reuse a stale auto-detection result", () => {
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    detectedSourceLang: "en",
    hasFreshCompletedTranslation: false,
    sourceLang: "auto",
    translation: "Stale result",
  }));

  assert.equal(plan.enabled, false);
  assert.equal(plan.movesTranslation, false);
  assert.equal(plan.reason, "auto-source-result-not-ready");
});

test("disables explicit or detected same-language pairs", () => {
  const explicit = swap.createFreeTranslationSwapPlan(createInput({
    sourceLang: "zh",
    targetLang: "zh",
  }));
  const detected = swap.createFreeTranslationSwapPlan(createInput({
    detectedSourceLang: "zh",
    hasFreshCompletedTranslation: true,
    sourceLang: "auto",
    targetLang: "zh",
    translation: "你好",
  }));

  assert.equal(explicit.enabled, false);
  assert.equal(explicit.reason, "same-language");
  assert.equal(detected.enabled, false);
  assert.equal(detected.reason, "same-language");
});

test("disables a translation that exceeds the source character limit without truncating it", () => {
  const translation = "x".repeat(6);
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    hasFreshCompletedTranslation: true,
    maxSourceCharacters: 5,
    translation,
  }));

  assert.equal(plan.enabled, false);
  assert.equal(plan.movesTranslation, false);
  assert.equal(plan.reason, "translation-too-long");
  assert.equal(plan.next.sourceText, "Hello");
});

test("allows a translation exactly at the source character limit", () => {
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    hasFreshCompletedTranslation: true,
    maxSourceCharacters: 5,
    translation: "12345",
  }));

  assert.equal(plan.enabled, true);
  assert.equal(plan.movesTranslation, true);
  assert.equal(plan.next.sourceText, "12345");
});

test("busy state takes priority and preserves the current state", () => {
  const plan = swap.createFreeTranslationSwapPlan(createInput({
    busy: true,
    detectedSourceLang: "en",
    hasFreshCompletedTranslation: true,
    sourceLang: "auto",
    translation: "你好",
  }));

  assert.deepEqual(plan, {
    enabled: false,
    movesTranslation: false,
    next: {
      sourceLang: "auto",
      sourceText: "Hello",
      targetLang: "zh",
    },
    reason: "busy",
  });
});

test("an empty completed payload is not treated as a movable translation", () => {
  const explicit = swap.createFreeTranslationSwapPlan(createInput({
    hasFreshCompletedTranslation: true,
    translation: "   ",
  }));
  const automatic = swap.createFreeTranslationSwapPlan(createInput({
    detectedSourceLang: "en",
    hasFreshCompletedTranslation: true,
    sourceLang: "auto",
    translation: "   ",
  }));

  assert.equal(explicit.enabled, true);
  assert.equal(explicit.movesTranslation, false);
  assert.equal(explicit.reason, "swap-languages");
  assert.equal(automatic.enabled, false);
  assert.equal(automatic.reason, "auto-source-result-not-ready");
});
