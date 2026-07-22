import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let autoStart;
let settings;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  [autoStart, settings] = await Promise.all([
    vite.ssrLoadModule("/src/mathpix/mathpixAutoStart.ts"),
    vite.ssrLoadModule("/src/settings/settingsRepository.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

test("MathPix auto-start defaults to enabled for new and legacy settings", () => {
  assert.equal(settings.DEFAULT_APP_SETTINGS.mathpixAutoStartEnabled, true);
  assert.equal(settings.normalizeAppSettings({}).mathpixAutoStartEnabled, true);
  assert.equal(
    settings.normalizeAppSettings({ mathpixAutoStartEnabled: "false" }).mathpixAutoStartEnabled,
    true,
  );
});

test("an explicit disabled MathPix auto-start preference is preserved", () => {
  assert.equal(
    settings.normalizeAppSettings({ mathpixAutoStartEnabled: false }).mathpixAutoStartEnabled,
    false,
  );
});

test("auto-start waits for settings hydration and runs only once per open document", () => {
  const baseInput = {
    enabled: true,
    fingerprint: "pdf-1",
    isSettingsHydrated: true,
    pipelineState: "idle",
  };

  assert.equal(autoStart.shouldAutoStartMathpix(baseInput), true);
  assert.equal(
    autoStart.shouldAutoStartMathpix({ ...baseInput, isSettingsHydrated: false }),
    false,
  );
  assert.equal(
    autoStart.shouldAutoStartMathpix({ ...baseInput, enabled: false }),
    false,
  );
  assert.equal(
    autoStart.shouldAutoStartMathpix({ ...baseInput, pipelineState: "running" }),
    false,
  );
  assert.equal(
    autoStart.shouldAutoStartMathpix({ ...baseInput, startedFingerprint: "pdf-1" }),
    false,
  );
});
