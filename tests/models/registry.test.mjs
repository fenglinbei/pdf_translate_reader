import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import {
  getAvailableModelIds, getModelDefinition, getModelIds, getModelLabel,
  isKnownModel, MODEL_CATALOG, MODEL_DEFAULTS, MODEL_IDS,
  resolveQaThinking, resolveTranslationReasoning,
} from "../../shared/modelRegistry.mjs";
import { TRANSLATION_MODELS } from "../../server/translationModels/client.mjs";
import { QA_CHAT_MODELS } from "../../server/chatModels/client.mjs";
import { getModelContextConfig } from "../../server/qa/contextBudget.mjs";
import { getModelProviderConfig, TRANSLATION_PROVIDER_KEY_NAMES } from "../../server/models/providerConfig.mjs";
import { handleHealth } from "../../server/routes/health.mjs";

let vite, frontend, history, settings;
before(async () => {
  vite = await createServer({ appType: "custom", configFile: false, logLevel: "silent", server: {middlewareMode: true} });
  [frontend, history, settings] = await Promise.all([
    vite.ssrLoadModule("/src/translation/models.ts"),
    vite.ssrLoadModule("/src/translation/freeTranslationRepository.ts"),
    vite.ssrLoadModule("/src/settings/settingsRepository.ts"),
  ]);
});
after(async () => { await vite?.close(); });

test("catalog scope is six core models and only GLM FlashX as optional", () => {
  assert.deepEqual(getModelIds({tier: "core"}).sort(), [
    "deepseek-flash", "glm-5.3", "glm-5.3-flash", "kimi-k3", "qwen3.8-flash", "qwen3.8-max",
  ]);
  assert.deepEqual(getModelIds({tier: "optional"}), ["glm-5.3-flashx"]);
  assert.equal(isKnownModel("kimi-k2.7-code-highspeed"), false);
  for (const id of ["__proto__", "constructor", "toString", null, {}]) {
    assert.equal(getModelDefinition(id), undefined);
  }
});

test("catalog profiles have consistent defaults, supported efforts and token bounds", () => {
  for (const id of MODEL_IDS) {
    const definition = MODEL_CATALOG[id];
    const translation = definition.reasoning.translation;
    assert.ok(translation.efforts.includes(translation.defaultEffort), id);
    for (const effort of translation.efforts) {
      assert.ok(definition.reasoning.providerEfforts.includes(definition.reasoning.translationEffortMap[effort]), id);
    }
    for (const mode of Object.values(definition.reasoning.qa)) {
      assert.ok(mode.enabled || translation.canDisable, id);
      if (mode.effort) assert.ok(definition.reasoning.providerEfforts.includes(mode.effort), id);
    }
    assert.ok(definition.context.defaultMaxTokens <= definition.context.maxOutputTokens, id);
    assert.ok(definition.context.defaultMaxTokens < definition.context.contextWindow, id);
    assert.ok(Object.isFrozen(definition.reasoning.translation), id);
  }
});

test("always-thinking models retain low effort when disabling is requested", () => {
  for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "kimi-k3"]) {
    assert.deepEqual(resolveTranslationReasoning(id, {enabled: false, effort: "low"}), {
      enabled: true, effort: "low", forced: true, requestedEnabled: false,
    });
    assert.deepEqual(resolveQaThinking(id, "quick"), {enabled: true, effort: "low"});
  }
});

test("Qwen and DeepSeek quick modes differ from forced-thinking models", () => {
  for (const id of ["qwen3.8-max", "qwen3.8-flash", "deepseek-flash"]) {
    assert.deepEqual(resolveQaThinking(id, "quick"), {enabled: false});
  }
  assert.deepEqual(resolveQaThinking("qwen3.8-max", "standard"), {enabled: true, effort: "medium"});
  assert.deepEqual(resolveQaThinking("qwen3.8-max", "deep"), {enabled: true, effort: "xhigh"});
  assert.deepEqual(resolveQaThinking("deepseek-flash", "constructor"), {enabled: true, effort: "high"});
});

test("frontend choices and backend request allowlist use identical readiness", () => {
  assert.deepEqual(frontend.TRANSLATION_MODEL_OPTIONS.map(({id}) => id), [...TRANSLATION_MODELS]);
  assert.deepEqual(getAvailableModelIds("qa"), [...QA_CHAT_MODELS]);
  assert.equal(settings.DEFAULT_APP_SETTINGS.defaultModel, "deepseek-flash");
  assert.equal(MODEL_DEFAULTS.translation, "deepseek-flash");
  assert.equal(MODEL_DEFAULTS.qa, "deepseek-v4-pro"); // QA default awaits evaluation.
  for (const id of getModelIds({tier: "core"})) {
    assert.ok(TRANSLATION_MODELS.has(id), id);
    assert.ok(QA_CHAT_MODELS.has(id), id);
  }
  assert.equal(settings.normalizeAppSettings({defaultModel: "qwen3.8-max"}).defaultModel, "qwen3.8-max");
  assert.equal(settings.normalizeAppSettings({defaultModel: "unknown"}).defaultModel, "deepseek-flash");
});

test("historical model identities and reasoning settings survive catalog migration", () => {
  for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2", "kimi-k3"]) {
    const draft = history.createFreeTranslationDraft({
      userId: "test-user", sourceText: "Hello", sourceLang: "en", targetLang: "zh", model: id,
    });
    const record = history.createFreeTranslationRecord({userId: "test-user", sourceText: "Hello", translation: "你好", request: {...draft, promptVersion: "test-v1"}});
    assert.equal(record.request.model, id);
    assert.equal(frontend.getTranslationModelShortLabel(id), MODEL_CATALOG[id].shortLabel);
  }
  assert.equal(getModelLabel("deepseek-v4-flash"), "DeepSeek V4 Flash");
  assert.equal(getModelLabel("deepseek-flash"), "DeepSeek V4.1 Flash");
});

test("unknown context windows fail instead of assuming a million tokens", () => {
  assert.equal(getModelContextConfig("qwen3.8-max").contextWindow, 1_000_000);
  assert.throws(() => getModelContextConfig("unknown-model"), /Unknown QA context budget/);
  assert.throws(() => getModelContextConfig("__proto__"), /Unknown QA context budget/);
});

test("Aliyun credentials take precedence and the workspace URL is explicit", () => {
  const config = getModelProviderConfig("qwen", {
    ALIYUN_API_KEY: "test-aliyun-key", DASHSCOPE_API_KEY: "test-dashscope-key",
    ALIYUN_API_BASE_URL: "https://workspace.example/compatible-mode/v1/",
  });
  assert.equal(config.apiKeyName, "ALIYUN_API_KEY");
  assert.equal(config.apiKey, "test-aliyun-key");
  assert.equal(config.apiBaseUrl, "https://workspace.example/compatible-mode/v1");
  assert.equal(getModelProviderConfig("qwen", {DASHSCOPE_API_KEY: "alias"}).apiKeyName, "DASHSCOPE_API_KEY");
  assert.equal(getModelProviderConfig("qwen", {ALIYUN_API_KEY: "key"}).apiBaseUrlConfigured, false);
  assert.ok(TRANSLATION_PROVIDER_KEY_NAMES.includes("ALIYUN_API_KEY"));
  assert.throws(() => getModelProviderConfig("__proto__", {}), /Unknown model provider/);
});

test("health exposes Qwen configuration flags without disclosing credentials or endpoint", () => {
  const original = {key: process.env.ALIYUN_API_KEY, url: process.env.ALIYUN_API_BASE_URL};
  try {
    process.env.ALIYUN_API_KEY = "do-not-expose-this-key";
    process.env.ALIYUN_API_BASE_URL = "https://private-workspace.example/v1";
    let body;
    handleHealth({writeHead() {}, end(value) {body = value;}});
    assert.deepEqual(JSON.parse(body).translation.qwen, {apiKeyConfigured: true, apiBaseUrlConfigured: true});
    assert.equal(body.includes("do-not-expose-this-key"), false);
    assert.equal(body.includes("private-workspace"), false);
  } finally {
    for (const [name, value] of [["ALIYUN_API_KEY", original.key], ["ALIYUN_API_BASE_URL", original.url]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
