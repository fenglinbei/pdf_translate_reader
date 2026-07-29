import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let i18n;
let panel;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  panel = await vite.ssrLoadModule("/src/translation/FreeTranslationPanel.tsx");
  i18n = await vite.ssrLoadModule("/src/i18n/I18nProvider.tsx");
});

after(async () => {
  await vite?.close();
});

test("long reasoning timelines show the latest five stages by default", () => {
  const parts = createParts(9);
  const collapsed = panel.getFreeTranslationReasoningWindow(parts, false);
  const expanded = panel.getFreeTranslationReasoningWindow(parts, true);

  assert.equal(collapsed.olderCount, 4);
  assert.deepEqual(
    collapsed.visibleParts.map((part) => part.partId),
    ["stage-5", "stage-6", "stage-7", "stage-8", "stage-9"],
  );
  assert.equal(expanded.olderCount, 4);
  assert.deepEqual(expanded.visibleParts, parts);
});

test("short reasoning timelines remain fully visible", () => {
  const parts = createParts(5);
  const result = panel.getFreeTranslationReasoningWindow(parts, false);

  assert.equal(result.olderCount, 0);
  assert.deepEqual(result.visibleParts, parts);
});

test("reasoning auto-follow remains enabled only near the bottom", () => {
  assert.equal(panel.isFreeTranslationReasoningAtBottom({
    clientHeight: 200,
    scrollHeight: 500,
    scrollTop: 276,
  }), true);
  assert.equal(panel.isFreeTranslationReasoningAtBottom({
    clientHeight: 200,
    scrollHeight: 500,
    scrollTop: 275,
  }), false);
  assert.equal(panel.isFreeTranslationReasoningAtBottom({
    clientHeight: 200,
    scrollHeight: 180,
    scrollTop: 0,
  }), true);
});

test("completed reasoning titles include elapsed time and the full stage count", () => {
  const zh = i18n.createI18n("zh-CN");

  assert.equal(
    panel.getReasoningStatusLabel("complete", 1_250, 9, zh.t),
    "已思考 2 秒 · 9 个阶段",
  );
  assert.equal(
    panel.getReasoningStatusLabel("complete", undefined, 9, zh.t),
    "思考完成 · 9 个阶段",
  );
  assert.equal(
    panel.getReasoningStatusLabel("stopped", 1_250, 9, zh.t),
    "思考已停止",
  );
});

function createParts(count) {
  return Array.from({ length: count }, (_, index) => ({
    complete: index < count - 1,
    firstSeq: index + 1,
    partId: `stage-${index + 1}`,
    text: `Stage ${index + 1}`,
  }));
}
