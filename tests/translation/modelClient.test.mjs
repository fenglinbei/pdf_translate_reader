import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createTranslationChatStream,
  normalizeTranslationModel,
  resolveTranslationReasoningConfig,
  TranslationModelError,
} from "../../server/translationModels/client.mjs";
import {
  createTranslationReasoningSanitizer,
} from "../../server/translationModels/reasoningSummary.mjs";
import { FREE_TRANSLATION_MAX_SOURCE_CHARS } from "../../server/deepseek/prompt.mjs";
import { handleTranslateStream } from "../../server/routes/translate.mjs";

const MANAGED_ENV_KEYS = [
  "DEEPSEEK_API_BASE_URL",
  "DEEPSEEK_API_KEY",
  "GLM_API_BASE_URL",
  "GLM_API_KEY",
  "GLM_TRANSLATION_MAX_TOKENS",
  "KIMI_API_BASE_URL",
  "KIMI_API_KEY",
  "KIMI_BASE_URL",
  "KIMI_TRANSLATION_MAX_COMPLETION_TOKENS",
];

const originalEnv = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const originalFetch = globalThis.fetch;
const messages = [
  { role: "system", content: "Translate only." },
  { role: "user", content: "Hello" },
];

beforeEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const key of MANAGED_ENV_KEYS) {
    const value = originalEnv[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("translation model client", () => {
  it("keeps the existing DeepSeek translation request shape", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.DEEPSEEK_API_BASE_URL = "https://deepseek.example/v1";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({ messages, model: "deepseek-v4-pro" });

    assert.equal(request.url, "https://deepseek.example/v1/chat/completions");
    assert.deepEqual(request.body, {
      messages,
      model: "deepseek-v4-pro",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      thinking: { type: "disabled" },
    });
  });

  it("honors an explicit disabled reasoning request for DeepSeek", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.DEEPSEEK_API_BASE_URL = "https://deepseek.example/v1";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({
      messages,
      model: "deepseek-v4-flash",
      resolvedReasoning: createResolvedReasoning({
        effort: "max",
        enabled: false,
        requestedEnabled: false,
      }),
    });

    assert.deepEqual(request.body, {
      messages,
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      thinking: { type: "disabled" },
    });
    assert.equal("reasoning_effort" in request.body, false);
  });

  it("disables GLM thinking and sampling for translation", async () => {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.GLM_API_BASE_URL = "https://glm.example/v4/";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({ messages, model: "glm-5.2" });

    assert.equal(request.url, "https://glm.example/v4/chat/completions");
    assert.deepEqual(request.body, {
      do_sample: false,
      max_tokens: 16_384,
      messages,
      model: "glm-5.2",
      stream: true,
      thinking: { type: "disabled" },
    });
  });

  it("honors an explicit disabled reasoning request for GLM", async () => {
    process.env.GLM_API_KEY = "test-glm-key";
    process.env.GLM_API_BASE_URL = "https://glm.example/v4/";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({
      messages,
      model: "glm-5.2",
      resolvedReasoning: createResolvedReasoning({
        effort: "max",
        enabled: false,
        requestedEnabled: false,
      }),
    });

    assert.deepEqual(request.body, {
      do_sample: false,
      max_tokens: 16_384,
      messages,
      model: "glm-5.2",
      stream: true,
      thinking: { type: "disabled" },
    });
    assert.equal("reasoning_effort" in request.body, false);
  });

  it("uses Kimi K3 fixed-parameter compatible payload", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    process.env.KIMI_API_BASE_URL = "https://kimi.example/v1/";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({ messages, model: "kimi-k3" });

    assert.equal(request.url, "https://kimi.example/v1/chat/completions");
    assert.deepEqual(request.body, {
      max_completion_tokens: 16_384,
      messages,
      model: "kimi-k3",
      stream: true,
      stream_options: { include_usage: true },
    });
    assert.equal("temperature" in request.body, false);
    assert.equal("thinking" in request.body, false);
  });

  for (const {
    effort,
    expectedEffort,
    model,
  } of [
    {
      effort: "low",
      expectedEffort: "high",
      model: "deepseek-v4-flash",
    },
    {
      effort: "high",
      expectedEffort: "high",
      model: "deepseek-v4-pro",
    },
    {
      effort: "max",
      expectedEffort: "max",
      model: "deepseek-v4-pro",
    },
  ]) {
    it(`maps ${model} ${effort} reasoning to provider effort ${expectedEffort}`, async () => {
      process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
      process.env.DEEPSEEK_API_BASE_URL = "https://deepseek.example/v1";
      const request = captureSuccessfulRequest();

      await createTranslationChatStream({
        messages,
        model,
        resolvedReasoning: createResolvedReasoning({
          effort,
          enabled: true,
          requestedEnabled: true,
        }),
      });

      assert.equal(request.body.model, model);
      assert.deepEqual(request.body.thinking, { type: "enabled" });
      assert.equal(request.body.reasoning_effort, expectedEffort);
      assert.equal("temperature" in request.body, false);
    });
  }

  for (const { effort, expectedEffort } of [
    { effort: "low", expectedEffort: "high" },
    { effort: "high", expectedEffort: "high" },
    { effort: "max", expectedEffort: "max" },
  ]) {
    it(`maps GLM ${effort} reasoning to provider effort ${expectedEffort}`, async () => {
      process.env.GLM_API_KEY = "test-glm-key";
      process.env.GLM_API_BASE_URL = "https://glm.example/v4/";
      const request = captureSuccessfulRequest();

      await createTranslationChatStream({
        messages,
        model: "glm-5.2",
        resolvedReasoning: createResolvedReasoning({
          effort,
          enabled: true,
          requestedEnabled: true,
        }),
      });

      assert.equal(request.body.do_sample, false);
      assert.deepEqual(request.body.thinking, { type: "enabled" });
      assert.equal(request.body.reasoning_effort, expectedEffort);
      assert.equal("temperature" in request.body, false);
    });
  }

  for (const effort of ["low", "high", "max"]) {
    it(`adjusts Kimi K3 reasoning intensity to ${effort} without a thinking field`, async () => {
      process.env.KIMI_API_KEY = "test-kimi-key";
      process.env.KIMI_API_BASE_URL = "https://kimi.example/v1/";
      const request = captureSuccessfulRequest();

      await createTranslationChatStream({
        messages,
        model: "kimi-k3",
        resolvedReasoning: createResolvedReasoning({
          effort,
          enabled: true,
          requestedEnabled: true,
        }),
      });

      assert.equal(request.body.reasoning_effort, effort);
      assert.equal("thinking" in request.body, false);
      assert.equal("temperature" in request.body, false);
    });
  }

  it("uses Kimi K3 effective reasoning when a disabled request is forced on", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    process.env.KIMI_API_BASE_URL = "https://kimi.example/v1/";
    const request = captureSuccessfulRequest();

    await createTranslationChatStream({
      messages,
      model: "kimi-k3",
      resolvedReasoning: createResolvedReasoning({
        effort: "low",
        enabled: true,
        forced: true,
        requestedEnabled: false,
      }),
    });

    assert.equal(request.body.reasoning_effort, "low");
    assert.equal("thinking" in request.body, false);
  });

  it("reports the selected provider when its key is missing", async () => {
    await assert.rejects(
      createTranslationChatStream({ messages, model: "kimi-k3" }),
      (error) => {
        assert.ok(error instanceof TranslationModelError);
        assert.equal(error.code, "kimi_api_key_missing");
        assert.equal(error.statusCode, 500);
        return true;
      },
    );
  });

  it("falls back only for an absent or unsupported model", () => {
    assert.equal(normalizeTranslationModel("glm-5.2"), "glm-5.2");
    assert.equal(normalizeTranslationModel("kimi-k3"), "kimi-k3");
    assert.equal(normalizeTranslationModel("unsupported"), "deepseek-v4-flash");
  });

  it("normalizes legacy reasoning defaults by model", () => {
    for (const [model, expected] of [
      [
        "deepseek-v4-flash",
        {
          effort: "high",
          enabled: false,
          forced: false,
          requestedEnabled: false,
        },
      ],
      [
        "deepseek-v4-pro",
        {
          effort: "high",
          enabled: false,
          forced: false,
          requestedEnabled: false,
        },
      ],
      [
        "glm-5.2",
        {
          effort: "high",
          enabled: false,
          forced: false,
          requestedEnabled: false,
        },
      ],
      [
        "kimi-k3",
        {
          effort: "max",
          enabled: true,
          forced: false,
          requestedEnabled: true,
        },
      ],
    ]) {
      assert.deepEqual(resolveTranslationReasoningConfig(model), expected);
    }
  });

  it("normalizes unsupported reasoning values and exposes Kimi forced-on behavior", () => {
    assert.deepEqual(
      resolveTranslationReasoningConfig("glm-5.2", {
        effort: "extreme",
        enabled: "false",
      }),
      {
        effort: "high",
        enabled: false,
        forced: false,
        requestedEnabled: false,
      },
    );
    assert.deepEqual(
      resolveTranslationReasoningConfig("kimi-k3", {
        effort: "low",
        enabled: false,
      }),
      {
        effort: "low",
        enabled: true,
        forced: true,
        requestedEnabled: false,
      },
    );
  });

  it("opens SSE immediately without a speculative summary request and aborts on close", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const calls = [];
    const translationStarted = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      calls.push(call);
      translationStarted.resolve(call);

      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);
    const translationCall = await translationStarted.promise;
    const events = parseSseEvents(response.output);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headersSent, true);
    assert.equal(calls.length, 1);
    assert.equal(
      events.some((event) => event.eventName === "thinking_started"),
      true,
    );
    assert.deepEqual(
      events
        .filter((event) => event.eventName === "progress")
        .map((event) => event.payload.phase)
        .slice(0, 2),
      ["accepted", "connecting"],
    );
    assert.equal(translationCall.signal.aborted, false);

    response.emitClose();
    await routePromise;

    assert.equal(translationCall.signal.aborted, true);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("streams multiple sanitized reasoning parts from real reasoning with single-flight merging", async () => {
    process.env.DEEPSEEK_API_BASE_URL = "https://deepseek-summary.example/v1";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const firstRaw = `RAW_FIRST_PRIVATE_SENTINEL_${"A".repeat(160)}`;
    const secondRaw = `RAW_SECOND_PRIVATE_SENTINEL_${"B".repeat(380)}`;
    const requests = [];
    const mainStream = createControlledSseResponse();
    const sanitizerStreams = [
      createControlledSseResponse(),
      createControlledSseResponse(),
    ];
    const sanitizerStarts = [createDeferred(), createDeferred()];
    let sanitizerIndex = 0;
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      requests.push(call);

      if (isReasoningSanitizerCall(call)) {
        const index = sanitizerIndex;
        sanitizerIndex += 1;
        sanitizerStarts[index].resolve(call);
        return sanitizerStreams[index].response;
      }

      return mainStream.response;
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: firstRaw },
        finish_reason: null,
      }],
    });
    const firstSanitizerCall = await sanitizerStarts[0].promise;

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: secondRaw },
        finish_reason: null,
      }],
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.filter(isReasoningSanitizerCall).length, 1);

    writeSuccessfulSanitizerResult(
      sanitizerStreams[0],
      "正在核对术语与句法关系。",
      { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 },
    );
    await waitForSseEvent(response, "thinking_summary_text_done", 1);
    const secondSanitizerCall = await sanitizerStarts[1].promise;

    writeSuccessfulSanitizerResult(
      sanitizerStreams[1],
      "正在调整语气并保持文档结构。",
      { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
    );
    await waitForSseEvent(response, "thinking_summary_text_done", 2);

    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "你好" }, finish_reason: null }],
    });
    await waitForSseEvent(response, "delta", 1);
    mainStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        cached_tokens: 3,
        completion_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 4 },
        prompt_tokens: 10,
        total_tokens: 15,
      },
    });
    mainStream.writeDone();
    mainStream.close();
    await routePromise;

    const events = parseSseEvents(response.output);
    const eventNames = events.map((event) => event.eventName);
    const partAdded = events
      .filter((event) => event.eventName === "thinking_summary_part_added")
      .map((event) => event.payload);
    const textDone = events
      .filter((event) => event.eventName === "thinking_summary_text_done")
      .map((event) => event.payload);
    const summaryEvents = events.filter((event) =>
      event.eventName.startsWith("thinking_summary_")
    );
    const allSummarySequences = summaryEvents.map((event) => event.payload.seq);
    const completed = events
      .find((event) => event.eventName === "thinking_completed");

    assert.equal(requests.length, 3);
    assert.equal(firstSanitizerCall.body.model, "deepseek-v4-flash");
    assert.equal(firstSanitizerCall.body.stream, true);
    assert.ok(firstSanitizerCall.body.max_tokens <= 100);
    assert.deepEqual(firstSanitizerCall.body.thinking, { type: "disabled" });
    assert.match(
      firstSanitizerCall.body.messages[0].content,
      /private translation-reasoning window/i,
    );
    assert.match(JSON.stringify(firstSanitizerCall.body), /RAW_FIRST_PRIVATE/);
    assert.match(JSON.stringify(secondSanitizerCall.body), /RAW_SECOND_PRIVATE/);
    assert.match(
      JSON.stringify(secondSanitizerCall.body),
      /正在核对术语与句法关系/,
    );
    assert.deepEqual(
      partAdded.map(({ partId, source }) => ({ partId, source })),
      [
        {
          partId: "thinking-part-1",
          source: "deepseek-v4-flash",
        },
        {
          partId: "thinking-part-2",
          source: "deepseek-v4-flash",
        },
      ],
    );
    assert.deepEqual(
      textDone.map(({ partId, text }) => ({ partId, text })),
      [
        {
          partId: "thinking-part-1",
          text: "正在核对术语与句法关系。",
        },
        {
          partId: "thinking-part-2",
          text: "正在调整语气并保持文档结构。",
        },
      ],
    );
    assert.deepEqual(
      allSummarySequences,
      allSummarySequences.slice().sort((left, right) => left - right),
    );
    assert.equal(new Set(allSummarySequences).size, allSummarySequences.length);
    assert.equal(completed?.payload.degraded, false);
    assert.equal(completed?.payload.partCount, 2);
    assert.ok(Number.isFinite(completed?.payload.durationMs));
    assert.ok(
      eventNames.indexOf("thinking_completed") < eventNames.indexOf("delta"),
    );
    assert.ok(
      eventNames.indexOf("finish") < eventNames.indexOf("translation_complete"),
    );
    assert.equal(eventNames.at(-1), "done");
    assert.equal(
      events.filter((event) => event.eventName === "usage").at(-1)?.payload.totalTokens,
      28,
    );
    assert.doesNotMatch(response.output, /RAW_FIRST_PRIVATE/);
    assert.doesNotMatch(response.output, /RAW_SECOND_PRIVATE/);
    assert.doesNotMatch(response.output, /event: reasoning_summary/);
    assert.doesNotMatch(response.output, /event: error/);
  });

  it("caps the public thinking history at six persisted-safe parts", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const requests = [];
    const sanitizerStreams = [];
    const completedParts = [];
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      const stream = createControlledSseResponse();
      requests.push(call);
      sanitizerStreams.push(stream);
      return stream.response;
    };
    const sanitizer = createTranslationReasoningSanitizer({
      onTextDone: ({ text }) => completedParts.push(text),
      requestBody: {
        sourceLang: "auto",
        summaryLocale: "zh-CN",
        targetLang: "zh-CN",
      },
    });

    for (let index = 0; index < 6; index += 1) {
      sanitizer.push(
        `RAW_PERSISTENCE_WINDOW_${index}_${"R".repeat(360)}`,
      );
      await waitForCondition(
        () => sanitizerStreams.length === index + 1,
        `sanitizer request ${index + 1}`,
      );
      writeSuccessfulSanitizerResult(
        sanitizerStreams[index],
        `正在处理第${index + 1}阶段${"安".repeat(200)}`,
      );
      await waitForCondition(
        () => completedParts.length === index + 1,
        `thinking part ${index + 1}`,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }

    sanitizer.push(`RAW_SEVENTH_WINDOW_${"S".repeat(360)}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests.length, 6);
    assert.equal(sanitizer.snapshot().partCount, 6);
    assert.equal(completedParts.length, 6);
    assert.ok(
      completedParts.join("\n\n").length <= 1_200,
      "persisted public thinking history must fit the storage limit",
    );
    sanitizer.complete();
  });

  it("caps failed sanitizer attempts without affecting the main translation budget", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return Response.json(
        { error: { message: "sanitizer unavailable" } },
        { status: 503 },
      );
    };
    const sanitizer = createTranslationReasoningSanitizer({
      requestBody: {
        sourceLang: "auto",
        summaryLocale: "zh-CN",
        targetLang: "zh-CN",
      },
    });

    for (let index = 0; index < 8; index += 1) {
      sanitizer.push(`RAW_FAILED_WINDOW_${index}_${"T".repeat(360)}`);
      await waitForCondition(
        () => requests === index + 1,
        `failed sanitizer request ${index + 1}`,
      );
      await new Promise((resolve) => setImmediate(resolve));
    }

    sanitizer.push(`RAW_NINTH_FAILED_WINDOW_${"U".repeat(360)}`);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(requests, 8);
    assert.equal(sanitizer.snapshot().degraded, true);
    assert.equal(sanitizer.snapshot().partCount, 0);
    sanitizer.complete();
  });

  it("drops repeated and near-duplicate public progress without degrading", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const sanitizerStreams = [];
    const completedParts = [];
    globalThis.fetch = async () => {
      const stream = createControlledSseResponse();
      sanitizerStreams.push(stream);
      return stream.response;
    };
    const sanitizer = createTranslationReasoningSanitizer({
      onTextDone: ({ text }) => completedParts.push(text),
      requestBody: {
        sourceLang: "auto",
        summaryLocale: "zh-CN",
        targetLang: "zh-CN",
      },
    });
    const repeatedUpdate = "正在核对术语与句法关系。";

    sanitizer.push(`RAW_FIRST_DUPLICATE_WINDOW_${"V".repeat(360)}`);
    await waitForCondition(
      () => sanitizerStreams.length === 1,
      "first duplicate sanitizer request",
    );
    writeSuccessfulSanitizerResult(sanitizerStreams[0], repeatedUpdate);
    await waitForCondition(
      () => completedParts.length === 1,
      "first public thinking update",
    );
    await new Promise((resolve) => setImmediate(resolve));

    sanitizer.push(`RAW_SECOND_DUPLICATE_WINDOW_${"W".repeat(360)}`);
    await waitForCondition(
      () => sanitizerStreams.length === 2,
      "second duplicate sanitizer request",
    );
    writeSuccessfulSanitizerResult(sanitizerStreams[1], repeatedUpdate);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    sanitizer.push(`RAW_THIRD_DUPLICATE_WINDOW_${"X".repeat(360)}`);
    await waitForCondition(
      () => sanitizerStreams.length === 3,
      "near-duplicate sanitizer request",
    );
    writeSuccessfulSanitizerResult(
      sanitizerStreams[2],
      "正在核对术语与句法对应关系。",
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(completedParts, [repeatedUpdate]);
    assert.equal(sanitizer.snapshot().degraded, false);
    assert.equal(sanitizer.snapshot().partCount, 1);
    sanitizer.complete();
  });

  it("aborts an in-flight sanitizer before the first translation delta", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const rawReasoning = `RAW_ABORT_PRIVATE_${"C".repeat(180)}`;
    const mainStream = createControlledSseResponse();
    const sanitizerStarted = createDeferred();
    let sanitizerSignal;
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);

      if (isReasoningSanitizerCall(call)) {
        sanitizerSignal = init.signal;
        sanitizerStarted.resolve();

        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }

      return mainStream.response;
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: rawReasoning },
        finish_reason: null,
      }],
    });
    await sanitizerStarted.promise;
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "即时译文" }, finish_reason: null }],
    });
    await waitForSseEvent(response, "delta", 1);

    assert.equal(sanitizerSignal.aborted, true);
    const eventsBeforeFinish = parseSseEvents(response.output);
    const completedIndex = eventsBeforeFinish
      .findIndex((event) => event.eventName === "thinking_completed");
    const deltaIndex = eventsBeforeFinish
      .findIndex((event) => event.eventName === "delta");
    const completed = eventsBeforeFinish[completedIndex];

    assert.ok(completedIndex >= 0 && completedIndex < deltaIndex);
    assert.equal(completed.payload.partCount, 0);
    assert.equal(completed.payload.degraded, false);

    mainStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    mainStream.writeDone();
    mainStream.close();
    await routePromise;

    assert.doesNotMatch(response.output, new RegExp(rawReasoning));
    assert.doesNotMatch(response.output, /thinking_summary_part_added/);
    assert.match(response.output, /event: done/);
  });

  it("marks a failed sanitizer as degraded without blocking translation", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const rawReasoning = `RAW_FAILED_PRIVATE_${"D".repeat(180)}`;
    const mainStream = createControlledSseResponse();
    const sanitizerFailed = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);

      if (isReasoningSanitizerCall(call)) {
        sanitizerFailed.resolve();
        return Response.json(
          { error: { message: "sanitizer quota exhausted" } },
          { status: 429 },
        );
      }

      return mainStream.response;
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: rawReasoning },
        finish_reason: null,
      }],
    });
    await sanitizerFailed.promise;
    await new Promise((resolve) => setImmediate(resolve));
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "译文" }, finish_reason: null }],
    });
    mainStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    mainStream.writeDone();
    mainStream.close();
    await routePromise;

    const completed = parseSseEvents(response.output)
      .find((event) => event.eventName === "thinking_completed");

    assert.equal(completed?.payload.degraded, true);
    assert.equal(completed?.payload.partCount, 0);
    assert.doesNotMatch(response.output, new RegExp(rawReasoning));
    assert.doesNotMatch(response.output, /sanitizer quota exhausted/);
    assert.doesNotMatch(response.output, /event: error/);
    assert.match(response.output, /event: done/);
  });

  it("rejects a sanitizer response that copies raw reasoning", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const rawReasoning = `RAW_ECHO_PRIVATE_SENTINEL_${"E".repeat(160)}`;
    const mainStream = createControlledSseResponse();
    const sanitizerStream = createControlledSseResponse();
    const sanitizerStarted = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);

      if (isReasoningSanitizerCall(call)) {
        sanitizerStarted.resolve();
        return sanitizerStream.response;
      }

      return mainStream.response;
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: rawReasoning },
        finish_reason: null,
      }],
    });
    await sanitizerStarted.promise;
    writeSuccessfulSanitizerResult(sanitizerStream, rawReasoning);
    await new Promise((resolve) => setImmediate(resolve));
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "安全译文" }, finish_reason: null }],
    });
    mainStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    mainStream.writeDone();
    mainStream.close();
    await routePromise;

    const completed = parseSseEvents(response.output)
      .find((event) => event.eventName === "thinking_completed");

    assert.equal(completed?.payload.degraded, true);
    assert.equal(completed?.payload.partCount, 0);
    assert.doesNotMatch(response.output, new RegExp(rawReasoning));
    assert.doesNotMatch(response.output, /thinking_summary_text_delta/);
    assert.match(response.output, /event: done/);
  });

  it("rejects a sanitizer response that embeds a short raw identifier", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const rawIdentifier = "SECRET42";
    const rawReasoning =
      `The private identifier is ${rawIdentifier}. ${"F".repeat(160)}`;
    const mainStream = createControlledSseResponse();
    const sanitizerStream = createControlledSseResponse();
    const sanitizerStarted = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);

      if (isReasoningSanitizerCall(call)) {
        sanitizerStarted.resolve();
        return sanitizerStream.response;
      }

      return mainStream.response;
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    mainStream.writeOpenAiChunk({
      choices: [{
        delta: { reasoning_content: rawReasoning },
        finish_reason: null,
      }],
    });
    await sanitizerStarted.promise;
    writeSuccessfulSanitizerResult(
      sanitizerStream,
      `核${rawIdentifier}对`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "安全译文" }, finish_reason: null }],
    });
    mainStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    mainStream.writeDone();
    mainStream.close();
    await routePromise;

    const completed = parseSseEvents(response.output)
      .find((event) => event.eventName === "thinking_completed");

    assert.equal(completed?.payload.degraded, true);
    assert.equal(completed?.payload.partCount, 0);
    assert.doesNotMatch(response.output, new RegExp(rawIdentifier));
    assert.doesNotMatch(response.output, /thinking_summary_text_delta/);
    assert.match(response.output, /event: done/);
  });

  it("rejects a six-character raw identifier embedded at an offset", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const rawIdentifier = "KEY742";
    const sanitizerStream = createControlledSseResponse();
    const sanitizerStarted = createDeferred();
    const completedParts = [];
    globalThis.fetch = async () => {
      sanitizerStarted.resolve();
      return sanitizerStream.response;
    };
    const sanitizer = createTranslationReasoningSanitizer({
      onTextDone: ({ text }) => completedParts.push(text),
      requestBody: {
        sourceLang: "auto",
        summaryLocale: "zh-CN",
        targetLang: "zh-CN",
      },
    });

    sanitizer.push(
      `The private identifier is ${rawIdentifier}. ${"G".repeat(160)}`,
    );
    await sanitizerStarted.promise;
    writeSuccessfulSanitizerResult(
      sanitizerStream,
      `核${rawIdentifier}对`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(completedParts, []);
    assert.equal(sanitizer.snapshot().degraded, true);
    assert.equal(sanitizer.snapshot().partCount, 0);
    sanitizer.complete();
  });

  it("requires both stop and DONE before marking a reasoning translation complete", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    let requests = 0;
    globalThis.fetch = async () => {
      requests += 1;
      return new Response([
        'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 });
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(requests, 1);
    assert.match(response.output, /event: delta/);
    assert.match(response.output, /event: thinking_completed/);
    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_stream_incomplete"/);
    assert.doesNotMatch(response.output, /event: translation_complete/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("drops unexpected raw reasoning and skips summary when thinking is disabled", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response([
        'data: {"choices":[{"delta":{"reasoning_content":"RAW_DISABLED_SECRET"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 });
    };
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      reasoningEnabled: false,
      requestKind: "free",
      sourceLang: "auto",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(fetchCalls, 1);
    assert.doesNotMatch(response.output, /RAW_DISABLED_SECRET/);
    assert.doesNotMatch(response.output, /event: thinking/);
    assert.doesNotMatch(response.output, /event: reasoning_summary/);
    assert.doesNotMatch(response.output, /event: error/);
    assert.match(response.output, /event: done/);
  });

  it("degrades gracefully without an extra call when the sanitizer key is unavailable", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response([
        'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 });
    };
    const request = createTranslationRequest({
      ...createRequestBody("kimi-k3"),
      reasoningEnabled: true,
      requestKind: "free",
      sourceLang: "auto",
      summaryLocale: "zh-CN",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    const events = parseSseEvents(response.output);
    const completed = events
      .find((event) => event.eventName === "thinking_completed");

    assert.equal(fetchCalls, 1);
    assert.equal(completed?.payload.degraded, true);
    assert.equal(completed?.payload.partCount, 0);
    assert.match(response.output, /event: thinking_started/);
    assert.doesNotMatch(response.output, /thinking_summary_part_added/);
    assert.doesNotMatch(response.output, /event: error/);
    assert.match(response.output, /event: done/);
  });

  it("accepts auto source detection for free translation and returns its prompt version", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const upstreamRequest = captureSuccessfulRequest();
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      requestKind: "free",
      sourceLang: "auto",
      targetSentence: "# Hello\n\n- World",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    const events = parseSseEvents(response.output);
    const detectedSourceLanguage = events
      .find((event) => event.eventName === "source_language");

    assert.equal(response.statusCode, 200);
    assert.match(response.output, /"promptVersion":"free-translation-v1"/);
    assert.equal(detectedSourceLanguage?.payload.language, "en");
    assert.equal(detectedSourceLanguage?.payload.source, "local");
    assert.ok(
      detectedSourceLanguage?.payload.confidence >= 0 &&
      detectedSourceLanguage?.payload.confidence <= 1,
    );
    assert.match(upstreamRequest.body.messages[0].content, /Auto-detect the source language/);
    assert.match(
      upstreamRequest.body.messages[1].content,
      /Source language: auto-detect from the source document/,
    );
  });

  it("does not emit detected-language metadata for an explicit free-translation source", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    captureSuccessfulRequest();
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      requestKind: "free",
      sourceLang: "en",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(
      parseSseEvents(response.output)
        .some((event) => event.eventName === "source_language"),
      false,
    );
  });

  it("keeps reasoning controls scoped to free translation requests", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    const upstreamRequest = captureSuccessfulRequest();
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      reasoningEffort: "max",
      reasoningEnabled: true,
      requestKind: "selection",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.deepEqual(upstreamRequest.body.thinking, { type: "disabled" });
    assert.equal("reasoning_effort" in upstreamRequest.body, false);
    const meta = parseSseEvents(response.output)
      .find((event) => event.eventName === "meta");
    assert.equal("reasoning" in meta.payload, false);
  });

  it("drops unexpected raw reasoning without summarizing selection translation", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response([
        'data: {"choices":[{"delta":{"reasoning_content":"RAW_SELECTION_SECRET"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200 });
    };
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    const events = parseSseEvents(response.output);
    const meta = events.find((event) => event.eventName === "meta");

    assert.equal(fetchCalls, 1);
    assert.equal("reasoning" in meta.payload, false);
    assert.doesNotMatch(response.output, /RAW_SELECTION_SECRET/);
    assert.doesNotMatch(response.output, /event: thinking/);
    assert.doesNotMatch(response.output, /event: reasoning_summary/);
    assert.match(response.output, /event: done/);
  });

  it("continues to reject auto source detection for selection translation", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("data: [DONE]\n\n", { status: 200 });
    };
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      sourceLang: "auto",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(response.statusCode, 400);
    assert.equal(fetchCalls, 0);
    assert.match(response.output, /Unsupported sourceLang: auto/);
  });

  it("rejects oversized free translation before calling a provider", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("data: [DONE]\n\n", { status: 200 });
    };
    const request = createTranslationRequest({
      ...createRequestBody("deepseek-v4-flash"),
      requestKind: "free",
      targetSentence: "a".repeat(FREE_TRANSLATION_MAX_SOURCE_CHARS + 1),
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(response.statusCode, 400);
    assert.equal(fetchCalls, 0);
    assert.match(response.output, /must be 20000 characters or fewer/);
    assert.match(response.output, /received 20001/);
  });

  it("normalizes GLM nested cache usage", async () => {
    process.env.GLM_API_KEY = "test-glm-key";
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop","usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":5}}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
    const request = createTranslationRequest(createRequestBody("glm-5.2"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /"promptCacheHitTokens":5/);
    assert.match(response.output, /"promptCacheMissTokens":7/);
    assert.match(response.output, /event: done/);
  });

  it("rejects an upstream stream that ends without the provider completion marker", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      { status: 200 },
    );
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /event: delta/);
    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_stream_incomplete"/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("never exposes raw thinking from a reasoning-only incomplete stream", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    globalThis.fetch = async () => new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"unfinished thought"}}]}\n\n',
      { status: 200 },
    );
    const request = createTranslationRequest({
      ...createRequestBody("kimi-k3"),
      reasoningEffort: "high",
      reasoningEnabled: true,
      requestKind: "free",
      sourceLang: "auto",
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.doesNotMatch(response.output, /unfinished thought/);
    assert.match(response.output, /event: thinking_started/);
    assert.match(response.output, /event: thinking_completed/);
    assert.doesNotMatch(response.output, /thinking_summary_text_delta/);
    assert.doesNotMatch(response.output, /event: reasoning_summary/);
    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_stream_incomplete"/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("rejects provider-truncated output even when the completion marker follows", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_stream_truncated"/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("rejects a provider error embedded in a successful HTTP stream", async () => {
    process.env.GLM_API_KEY = "test-glm-key";
    globalThis.fetch = async () => new Response([
      'data: {"error":{"code":"provider_failure","message":"RAW_PROVIDER_ERROR_SECRET"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
    const request = createTranslationRequest(createRequestBody("glm-5.2"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_upstream_stream_error"/);
    assert.doesNotMatch(response.output, /RAW_PROVIDER_ERROR_SECRET/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("rejects malformed upstream SSE without echoing its payload", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    globalThis.fetch = async () => new Response(
      'data: {"RAW_MALFORMED_STREAM_SECRET":\n\n',
      { status: 200 },
    );
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_upstream_stream_invalid"/);
    assert.doesNotMatch(response.output, /RAW_MALFORMED_STREAM_SECRET/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("does not start a provider request after the browser response is already destroyed", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("data: [DONE]\n\n", { status: 200 });
    };
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();
    response.destroyed = true;

    await handleTranslateStream(request, response);

    assert.equal(fetchCalls, 0);
  });

  it("aborts the provider request when the browser response closes", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    let upstreamSignal;
    let notifyFetchStarted;
    const fetchStarted = new Promise((resolve) => {
      notifyFetchStarted = resolve;
    });
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal;
      notifyFetchStarted();
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    };
    const request = createTranslationRequest(createRequestBody("kimi-k3"));
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    await fetchStarted;
    response.emitClose();
    await routePromise;

    assert.equal(upstreamSignal.aborted, true);
  });

});

function captureSuccessfulRequest() {
  const request = {};

  globalThis.fetch = async (url, init) => {
    request.url = url;
    request.body = JSON.parse(init.body);
    request.headers = init.headers;
    return new Response("data: [DONE]\n\n", {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });
  };

  return request;
}

function createTranslationRequest(body) {
  return {
    destroyed: false,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(body));
    },
    on() {
      return this;
    },
  };
}

function createResolvedReasoning({
  effort,
  enabled,
  forced = false,
  requestedEnabled,
}) {
  return {
    effort,
    enabled,
    forced,
    requestedEnabled,
  };
}

function createRequestBody(model) {
  return {
    contextWindowN: 0,
    localContextAfter: [],
    localContextBefore: [],
    longContextEnabled: false,
    model,
    requestKind: "selection",
    sourceLang: "en",
    stream: true,
    targetLang: "zh",
    targetSentence: "Hello",
    translationStyle: { presetId: "academic-faithful" },
  };
}

function createReasoningFreeTranslationRequest(model) {
  return createTranslationRequest({
    ...createRequestBody(model),
    reasoningEffort: "low",
    reasoningEnabled: true,
    requestKind: "free",
    sourceLang: "auto",
    summaryLocale: "zh-CN",
  });
}

function captureFetchCall(url, init) {
  return {
    body: JSON.parse(init.body),
    headers: init.headers,
    signal: init.signal,
    url,
  };
}

function isReasoningSanitizerCall(call) {
  return call?.body?.model === "deepseek-v4-flash" &&
    call.body.stream === true &&
    typeof call.body.messages?.[0]?.content === "string" &&
    /private translation-reasoning window/i
      .test(call.body.messages[0].content);
}

function isTranslationCall(call) {
  return Boolean(call) && !isReasoningSanitizerCall(call);
}

function findTranslationCall(calls) {
  return calls.find(isTranslationCall);
}

function createSuccessfulTranslationResponse({
  content,
  reasoningContent,
}) {
  const chunks = [];

  if (reasoningContent) {
    chunks.push(
      `data: ${JSON.stringify({
        choices: [{ delta: { reasoning_content: reasoningContent }, finish_reason: null }],
      })}`,
      "",
    );
  }

  chunks.push(
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: null }],
    })}`,
    "",
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}`,
    "",
    "data: [DONE]",
    "",
  );

  return new Response(chunks.join("\n"), {
    headers: { "Content-Type": "text/event-stream" },
    status: 200,
  });
}

function createControlledSseResponse() {
  const encoder = new TextEncoder();
  let controller;
  const stream = new ReadableStream({
    start(value) {
      controller = value;
    },
  });

  return {
    close() {
      controller.close();
    },
    response: new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    }),
    writeDone() {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    },
    writeOpenAiChunk(chunk) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
      );
    },
  };
}

function writeSuccessfulSanitizerResult(
  stream,
  text,
  usage = {
    completion_tokens: 2,
    prompt_tokens: 4,
    total_tokens: 6,
  },
) {
  stream.writeOpenAiChunk({
    choices: [{ delta: { content: text }, finish_reason: null }],
  });
  stream.writeOpenAiChunk({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage,
  });
  stream.writeDone();
  stream.close();
}

function createDeferred() {
  let reject;
  let resolve;
  const promise = new Promise((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });

  return { promise, reject, resolve };
}

async function waitForSseEvent(response, eventName, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      parseSseEvents(response.output)
        .filter((event) => event.eventName === eventName)
        .length >= count
    ) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(`Timed out waiting for ${count} ${eventName} SSE event(s).`);
}

async function waitForCondition(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail(`Timed out waiting for ${label}.`);
}

function parseSseEvents(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let eventName = "message";
      const dataLines = [];

      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      return {
        eventName,
        payload: JSON.parse(dataLines.join("\n")),
      };
    });
}

function createTranslationResponse() {
  const listeners = new Map();

  return {
    ended: false,
    headersSent: false,
    output: "",
    statusCode: undefined,
    writableEnded: false,
    end(chunk) {
      if (chunk) {
        this.output += chunk;
      }
      this.ended = true;
      this.writableEnded = true;
    },
    emitClose() {
      this.destroyed = true;
      const handler = listeners.get("close");
      listeners.delete("close");
      handler?.();
    },
    off(eventName, handler) {
      if (listeners.get(eventName) === handler) {
        listeners.delete(eventName);
      }
      return this;
    },
    once(eventName, handler) {
      listeners.set(eventName, handler);
      return this;
    },
    write(chunk) {
      this.output += chunk;
    },
    writeHead(statusCode) {
      this.headersSent = true;
      this.statusCode = statusCode;
    },
  };
}
