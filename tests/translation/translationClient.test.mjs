import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let client;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  client = await vite.ssrLoadModule("/src/translation/translationClient.ts");
});

after(async () => {
  await vite?.close();
});

test("thinking timeline updates the active part in place and retains completed parts", () => {
  let timeline = client.createTranslationThinkingTimeline();

  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    kind: "part_added",
    partId: "meaning",
    seq: 1,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: "Checking the core ",
    kind: "text_delta",
    partId: "meaning",
    seq: 2,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: "meaning.",
    kind: "text_delta",
    partId: "meaning",
    seq: 3,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    kind: "text_done",
    partId: "meaning",
    seq: 4,
    text: "Checked the core meaning.",
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    kind: "part_added",
    partId: "style",
    seq: 5,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: "Matching the requested style.",
    kind: "text_delta",
    partId: "style",
    seq: 6,
  });

  assert.deepEqual(
    timeline.parts.map(({ complete, partId, text }) => ({
      complete,
      partId,
      text,
    })),
    [
      {
        complete: true,
        partId: "meaning",
        text: "Checked the core meaning.",
      },
      {
        complete: false,
        partId: "style",
        text: "Matching the requested style.",
      },
    ],
  );
  assert.equal(
    client.getTranslationThinkingText(timeline),
    "Checked the core meaning.\n\nMatching the requested style.",
  );
});

test("thinking timeline rejects duplicate and out-of-order sequence events across parts", () => {
  let timeline = client.createTranslationThinkingTimeline();

  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    kind: "part_added",
    partId: "one",
    seq: 1,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: "A",
    kind: "text_delta",
    partId: "one",
    seq: 2,
  });
  const accepted = timeline;

  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: " duplicate",
    kind: "text_delta",
    partId: "one",
    seq: 2,
  });
  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    kind: "part_added",
    partId: "late-part",
    seq: 1,
  });

  assert.equal(timeline, accepted);
  assert.equal(timeline.parts.length, 1);
  assert.equal(timeline.parts[0].text, "A");
});

test("thinking completion preserves text while closing the current node", () => {
  let timeline = client.createTranslationThinkingTimeline();

  timeline = client.reduceTranslationThinkingTimeline(timeline, {
    delta: "Current safe progress",
    kind: "text_delta",
    partId: "current",
    seq: 1,
  });
  const completed = client.completeTranslationThinkingTimeline(timeline);

  assert.equal(completed.parts[0].complete, true);
  assert.equal(completed.parts[0].text, "Current safe progress");
  assert.equal(completed.lastSeq, 1);
});
