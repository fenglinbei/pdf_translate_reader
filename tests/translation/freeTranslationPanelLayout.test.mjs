import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let layout;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  layout = await vite.ssrLoadModule(
    "/src/translation/freeTranslationPanelLayout.ts",
  );
});

after(async () => {
  await vite?.close();
});

test("free-translation panel defaults to the centered wide preset", () => {
  const viewport = {
    height: 1_080,
    left: 0,
    layoutWidth: 1_920,
    top: 0,
    width: 1_920,
  };
  const initial = layout.getInitialFreeTranslationLayout(undefined, viewport);

  assert.equal(layout.isFreeTranslationDesktopViewport(viewport), true);
  assert.equal(initial.mode, "wide");
  assert.deepEqual(initial.bounds, {
    height: 960,
    left: 160,
    top: 60,
    width: 1_600,
  });
  assert.equal(initial.sourceRatio, 50);
});

test("pinch zoom geometry does not change the responsive breakpoint", () => {
  assert.equal(
    layout.isFreeTranslationDesktopViewport({
      height: 540,
      left: 320,
      layoutWidth: 1_920,
      top: 180,
      width: 960,
    }),
    true,
  );
});

test("free-translation panel clamps to the visible viewport origin", () => {
  const viewport = {
    height: 700,
    left: 120,
    layoutWidth: 1_000,
    top: 80,
    width: 1_000,
  };

  assert.deepEqual(
    layout.createCenteredFreeTranslationBounds(
      layout.getFreeTranslationPresetSize("wide"),
      viewport,
    ),
    {
      height: 668,
      left: 136,
      top: 96,
      width: 968,
    },
  );
  assert.deepEqual(layout.createMaximizedFreeTranslationBounds(viewport), {
    height: 668,
    left: 136,
    top: 96,
    width: 968,
  });
});

test("free-translation pointer resizing respects minimums and visible edges", () => {
  const viewport = {
    height: 1_080,
    left: 0,
    layoutWidth: 1_920,
    top: 0,
    width: 1_920,
  };
  const startBounds = {
    height: 960,
    left: 160,
    top: 60,
    width: 1_600,
  };

  assert.deepEqual(
    layout.resizeFreeTranslationBounds(
      startBounds,
      { x: -10_000, y: -10_000 },
      viewport,
    ),
    {
      height: 600,
      left: 160,
      top: 60,
      width: 880,
    },
  );
  assert.deepEqual(
    layout.resizeFreeTranslationBounds(
      startBounds,
      { x: 10_000, y: 10_000 },
      viewport,
    ),
    {
      height: 1_004,
      left: 160,
      top: 60,
      width: 1_744,
    },
  );
});

test("free-translation source ratio remains within the supported range", () => {
  assert.equal(layout.clampFreeTranslationSourceRatio(Number.NaN), 50);
  assert.equal(layout.clampFreeTranslationSourceRatio(12), 30);
  assert.equal(layout.clampFreeTranslationSourceRatio(63.6), 64);
  assert.equal(layout.clampFreeTranslationSourceRatio(91), 70);
});
