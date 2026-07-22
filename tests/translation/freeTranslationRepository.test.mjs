import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let repository;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  repository = await vite.ssrLoadModule("/src/translation/freeTranslationRepository.ts");
});

after(async () => {
  await vite?.close();
});

test("free-translation draft normalization preserves Markdown and accepts auto detection", () => {
  const sourceText = "# Heading\n\n$$E=mc^2$$";
  const draft = repository.createFreeTranslationDraft({
    includePaperContext: false,
    model: "deepseek-v4-flash",
    sourceLang: "auto",
    sourceText,
    targetLang: "zh",
    terminology: [{ source: "mass", target: "质量" }],
    translationStyle: { presetId: "academic-faithful" },
    updatedAt: 123,
    userId: "user-1",
  });

  assert.equal(draft.sourceText, sourceText);
  assert.equal(draft.sourceLang, "auto");
  assert.equal(draft.updatedAt, 123);
  assert.deepEqual(draft.terminology, [{ source: "mass", target: "质量" }]);
});

test("history pruning keeps the newest records within the entry limit", () => {
  const records = [
    createRecord("oldest", 1, "a"),
    createRecord("middle", 2, "b"),
    createRecord("newest", 3, "c"),
  ];

  assert.deepEqual(
    repository.selectFreeTranslationHistoryIdsToDelete(records, {
      maxCharacters: 1_000,
      maxEntries: 2,
    }),
    ["oldest"],
  );
});

test("history pruning removes an old tail once the character budget is reached", () => {
  const records = [
    createRecord("old-small", 1, "a"),
    createRecord("middle-large", 2, "1234567"),
    createRecord("newest", 3, "1234"),
  ];

  assert.deepEqual(
    repository.selectFreeTranslationHistoryIdsToDelete(records, {
      maxCharacters: 10,
      maxEntries: 10,
    }),
    ["middle-large", "old-small"],
  );
});

test("history pruning always retains the newest record instead of truncating it", () => {
  const records = [
    createRecord("old", 1, "a"),
    createRecord("new-oversized", 2, "123456789"),
  ];

  assert.deepEqual(
    repository.selectFreeTranslationHistoryIdsToDelete(records, {
      maxCharacters: 3,
      maxEntries: 10,
    }),
    ["old"],
  );
});

function createRecord(id, createdAt, sourceText) {
  return {
    createdAt,
    id,
    request: {
      includePaperContext: false,
      model: "deepseek-v4-flash",
      promptVersion: "free-translation-v1",
      sourceLang: "auto",
      targetLang: "zh",
      terminology: [],
      translationStyle: { presetId: "academic-faithful" },
      translationStyleHash: "style-test",
    },
    schemaVersion: 1,
    sourceText,
    translation: "译文",
    updatedAt: createdAt,
    userId: "user-1",
  };
}
