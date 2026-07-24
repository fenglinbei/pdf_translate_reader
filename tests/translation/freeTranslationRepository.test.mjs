import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let repository;
let translationModels;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  repository = await vite.ssrLoadModule("/src/translation/freeTranslationRepository.ts");
  translationModels = await vite.ssrLoadModule("/src/translation/models.ts");
});

after(async () => {
  await vite?.close();
});

test("free-translation draft normalization preserves Markdown and accepts auto detection", () => {
  const sourceText = "# Heading\n\n$$E=mc^2$$";
  const draft = repository.createFreeTranslationDraft({
    includePaperContext: false,
    model: "deepseek-v4-flash",
    reasoningEffort: "max",
    reasoningEnabled: true,
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
  assert.equal(draft.reasoningEnabled, true);
  assert.equal(draft.reasoningEffort, "max");
  assert.equal(draft.updatedAt, 123);
  assert.deepEqual(draft.terminology, [{ source: "mass", target: "质量" }]);
});

test("reasoning controls expose only provider efforts that take effect", () => {
  assert.deepEqual(
    [...translationModels.getTranslationReasoningCapability("deepseek-v4-flash").efforts],
    ["high", "max"],
  );
  assert.deepEqual(
    [...translationModels.getTranslationReasoningCapability("glm-5.2").efforts],
    ["high", "max"],
  );
  assert.deepEqual(
    [...translationModels.getTranslationReasoningCapability("kimi-k3").efforts],
    ["low", "high", "max"],
  );
  assert.equal(
    translationModels.getTranslationReasoningCapability("kimi-k3").canDisable,
    false,
  );
});

for (const {
  expectedEffort,
  expectedEnabled,
  model,
} of [
  {
    expectedEffort: "high",
    expectedEnabled: false,
    model: "deepseek-v4-flash",
  },
  {
    expectedEffort: "high",
    expectedEnabled: false,
    model: "deepseek-v4-pro",
  },
  {
    expectedEffort: "high",
    expectedEnabled: false,
    model: "glm-5.2",
  },
  {
    expectedEffort: "max",
    expectedEnabled: true,
    model: "kimi-k3",
  },
]) {
  test(`legacy ${model} drafts recover the model-specific reasoning default`, () => {
    const draft = repository.createFreeTranslationDraft(
      createDraftInput(model),
    );

    assert.equal(draft.reasoningEnabled, expectedEnabled);
    assert.equal(draft.reasoningEffort, expectedEffort);
  });

  test(`legacy ${model} history snapshots recover the model-specific reasoning default`, () => {
    const record = repository.createFreeTranslationRecord({
      request: createRequestSnapshot(model),
      sourceText: "Source",
      translation: "译文",
      userId: "user-legacy",
    });

    assert.equal(record.request.reasoningEnabled, expectedEnabled);
    assert.equal(record.request.reasoningEffort, expectedEffort);
  });
}

test("free-translation history stores effective reasoning without storing its trace", () => {
  const record = repository.createFreeTranslationRecord({
    reasoning: "private chain of thought",
    request: {
      ...createRequestSnapshot("glm-5.2"),
      reasoningEffort: "low",
      reasoningEnabled: true,
    },
    sourceText: "Source",
    translation: "译文",
    usage: { reasoningTokens: 7 },
    userId: "user-new",
  });

  assert.equal(record.request.reasoningEnabled, true);
  assert.equal(record.request.reasoningEffort, "high");
  assert.equal(record.usage.reasoningTokens, 7);
  assert.equal("reasoning" in record, false);
  assert.equal("thinking" in record, false);
});

test("invalid persisted reasoning values fall back instead of coercing strings", () => {
  const deepSeekDraft = repository.createFreeTranslationDraft({
    ...createDraftInput("deepseek-v4-pro"),
    reasoningEffort: "extreme",
    reasoningEnabled: "false",
  });
  const kimiRecord = repository.createFreeTranslationRecord({
    request: {
      ...createRequestSnapshot("kimi-k3"),
      reasoningEffort: "extreme",
      reasoningEnabled: "false",
    },
    sourceText: "Source",
    translation: "译文",
    userId: "user-invalid",
  });

  assert.equal(deepSeekDraft.reasoningEnabled, false);
  assert.equal(deepSeekDraft.reasoningEffort, "high");
  assert.equal(kimiRecord.request.reasoningEnabled, true);
  assert.equal(kimiRecord.request.reasoningEffort, "max");
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

function createDraftInput(model) {
  return {
    includePaperContext: false,
    model,
    sourceLang: "auto",
    sourceText: "Source",
    targetLang: "zh",
    terminology: [],
    translationStyle: { presetId: "academic-faithful" },
    updatedAt: 123,
    userId: `user-draft-${model}`,
  };
}

function createRequestSnapshot(model) {
  return {
    includePaperContext: false,
    model,
    promptVersion: "free-translation-v1",
    sourceLang: "auto",
    targetLang: "zh",
    terminology: [],
    translationStyle: { presetId: "academic-faithful" },
    translationStyleHash: "style-test",
  };
}
