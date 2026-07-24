import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createTranslationChatStream,
  normalizeTranslationModel,
  resolveTranslationReasoningConfig,
  TranslationModelError,
} from "../../server/translationModels/client.mjs";
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

  it("opens SSE immediately and aborts concurrent translation and preview requests on close", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const calls = [];
    const bothRequestsStarted = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      calls.push(call);

      if (calls.length === 2) {
        bothRequestsStarted.resolve();
      }

      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    await bothRequestsStarted.promise;

    const eventsBeforeProvidersResolve = parseSseEvents(response.output);
    const progressPhases = eventsBeforeProvidersResolve
      .filter((event) => event.eventName === "progress")
      .map((event) => event.payload.phase);
    const translationCall = findTranslationCall(calls);
    const previewCall = findSummaryPreviewCall(calls);

    assert.equal(response.statusCode, 200);
    assert.equal(response.headersSent, true);
    assert.equal(
      eventsBeforeProvidersResolve.some((event) => event.eventName === "meta"),
      true,
    );
    assert.deepEqual(progressPhases.slice(0, 2), ["accepted", "connecting"]);
    assert.ok(translationCall);
    assert.ok(previewCall);
    assert.equal(translationCall.signal.aborted, false);
    assert.equal(previewCall.signal.aborted, false);

    response.emitClose();
    await routePromise;

    assert.equal(translationCall.signal.aborted, true);
    assert.equal(previewCall.signal.aborted, true);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("streams a safe preview beside translation, then publishes the final revision", async () => {
    process.env.DEEPSEEK_API_BASE_URL = "https://deepseek-summary.example/v1";
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const upstreamReasoning = "RAW_PRIVATE_REASONING_SENTINEL";
    const requests = [];
    const mainStream = createControlledSseResponse();
    const previewStream = createControlledSseResponse();
    const concurrentRequestsStarted = createDeferred();
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      requests.push(call);

      if (isTranslationCall(call)) {
        maybeResolveConcurrentRequests();
        return mainStream.response;
      }

      if (isSummaryPreviewCall(call)) {
        maybeResolveConcurrentRequests();
        return previewStream.response;
      }

      if (isSummaryFinalCall(call)) {
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: {
              content: "- 最终核对了语义、术语和结构。",
            },
          }],
          usage: {
            completion_tokens: 3,
            prompt_tokens: 6,
            total_tokens: 9,
          },
        });
      }

      throw new Error(`Unexpected translation test request: ${JSON.stringify(call.body)}`);

      function maybeResolveConcurrentRequests() {
        if (
          findTranslationCall(requests) &&
          findSummaryPreviewCall(requests)
        ) {
          concurrentRequestsStarted.resolve();
        }
      }
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    await concurrentRequestsStarted.promise;

    previewStream.writeOpenAiChunk({
      choices: [{ delta: { content: "- 正在核对" }, finish_reason: null }],
    });
    await waitForSseEvent(response, "reasoning_summary_delta", 1);
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { reasoning_content: upstreamReasoning }, finish_reason: null }],
    });
    mainStream.writeOpenAiChunk({
      choices: [{ delta: { content: "你好" }, finish_reason: null }],
    });
    await waitForSseEvent(response, "delta", 1);
    previewStream.writeOpenAiChunk({
      choices: [{ delta: { content: "术语与格式。" }, finish_reason: null }],
    });
    previewStream.writeOpenAiChunk({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: {
        completion_tokens: 2,
        prompt_tokens: 4,
        total_tokens: 6,
      },
    });
    previewStream.writeDone();
    previewStream.close();
    await new Promise((resolve) => setImmediate(resolve));
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
    await waitForSseEvent(response, "finish", 1);
    assert.equal(
      parseSseEvents(response.output)
        .some((event) => event.eventName === "translation_complete"),
      false,
    );
    mainStream.writeDone();
    mainStream.close();

    await routePromise;

    const events = parseSseEvents(response.output);
    const eventNames = events.map((event) => event.eventName);
    const progressPhases = events
      .filter((event) => event.eventName === "progress")
      .map((event) => event.payload.phase);
    const previewDeltas = events
      .filter((event) => event.eventName === "reasoning_summary_delta")
      .map((event) => event.payload);
    const finalSummary = events
      .find((event) => event.eventName === "reasoning_summary");
    const translationCall = findTranslationCall(requests);
    const previewCall = findSummaryPreviewCall(requests);
    const finalCall = findSummaryFinalCall(requests);
    const previewRequestText = JSON.stringify(previewCall.body);

    assert.equal(response.ended, true);
    assert.equal(requests.length, 3);
    assert.equal(translationCall.body.model, "kimi-k3");
    assert.equal(previewCall.url, "https://deepseek-summary.example/v1/chat/completions");
    assert.equal(previewCall.body.model, "deepseek-v4-flash");
    assert.equal(previewCall.body.stream, true);
    assert.ok(previewCall.body.max_tokens <= 120);
    assert.deepEqual(previewCall.body.thinking, { type: "disabled" });
    assert.match(previewCall.body.messages[0].content, /live preview/i);
    assert.equal(previewCall.headers.Authorization, "Bearer test-deepseek-key");
    assert.equal(previewCall.headers["Content-Type"], "application/json");
    assert.match(previewRequestText, /Hello/);
    assert.doesNotMatch(previewRequestText, /你好/);
    assert.doesNotMatch(previewRequestText, new RegExp(upstreamReasoning));
    assert.equal(finalCall.body.stream, false);
    assert.equal(finalCall.body.max_tokens, 220);
    assert.match(JSON.stringify(finalCall.body), /你好/);
    assert.doesNotMatch(JSON.stringify(finalCall.body), new RegExp(upstreamReasoning));
    assert.deepEqual(previewDeltas, [
      { revision: 1, seq: 1, text: "- 正在核对" },
      { revision: 1, seq: 2, text: "术语与格式。" },
    ]);
    assert.deepEqual(
      events.filter((event) => event.eventName === "delta").map((event) => event.payload),
      [{ text: "你好" }],
    );
    assert.deepEqual(
      events.find((event) => event.eventName === "translation_complete")?.payload,
      { finishReason: "stop" },
    );
    assert.deepEqual(finalSummary?.payload, {
      final: true,
      revision: 2,
      source: "deepseek-v4-flash",
      text: "- 最终核对了语义、术语和结构。",
    });
    assert.deepEqual(progressPhases, [
      "accepted",
      "connecting",
      "analyzing",
      "translating",
      "finalizing_summary",
      "complete",
    ]);
    assert.ok(eventNames.indexOf("reasoning_summary_delta") < eventNames.indexOf("delta"));
    assert.ok(
      eventNames.lastIndexOf("reasoning_summary_delta") > eventNames.indexOf("delta"),
    );
    assert.ok(eventNames.indexOf("finish") < eventNames.indexOf("translation_complete"));
    assert.ok(
      eventNames.indexOf("translation_complete") < eventNames.indexOf("reasoning_summary"),
    );
    assert.equal(eventNames.at(-1), "done");
    assert.equal(
      events.filter((event) => event.eventName === "usage").at(-1)?.payload.totalTokens,
      30,
    );
    assert.match(response.output, /"promptCacheHitTokens":3/);
    assert.match(response.output, /"promptCacheMissTokens":7/);
    assert.match(response.output, /"reasoningTokens":4/);
    assert.doesNotMatch(response.output, new RegExp(upstreamReasoning));
    assert.doesNotMatch(response.output, /event: thinking/);
    assert.doesNotMatch(response.output, /event: error/);
  });

  it("degrades a 429 preview and timed-out final summary without delaying completion", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      requests.push(call);

      if (isTranslationCall(call)) {
        return createSuccessfulTranslationResponse({
          content: "你好",
          reasoningContent: "RAW_FALLBACK_SECRET",
        });
      }

      if (isSummaryPreviewCall(call)) {
        return Response.json(
          { error: { message: "preview quota exhausted" } },
          { status: 429 },
        );
      }

      if (isSummaryFinalCall(call)) {
        throw new DOMException("The operation timed out", "TimeoutError");
      }

      throw new Error(`Unexpected translation test request: ${JSON.stringify(call.body)}`);
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    const events = parseSseEvents(response.output);
    const eventNames = events.map((event) => event.eventName);
    const summary = events.find((event) => event.eventName === "reasoning_summary");

    assert.equal(requests.length, 3);
    assert.equal(response.statusCode, 200);
    assert.equal(response.ended, true);
    assert.deepEqual(
      events.find((event) => event.eventName === "translation_complete")?.payload,
      { finishReason: "stop" },
    );
    assert.equal(summary?.payload.source, "local");
    assert.equal(summary?.payload.revision, 2);
    assert.equal(summary?.payload.final, true);
    assert.match(summary?.payload.text, /核心语义|翻译风格/);
    assert.ok(eventNames.indexOf("translation_complete") < eventNames.indexOf("done"));
    assert.equal(eventNames.at(-1), "done");
    assert.doesNotMatch(response.output, /RAW_FALLBACK_SECRET/);
    assert.doesNotMatch(response.output, /preview quota exhausted/);
    assert.doesNotMatch(response.output, /event: error/);
  });

  it("requires both stop and DONE before marking a reasoning translation complete", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      requests.push(call);

      if (isTranslationCall(call)) {
        return new Response([
          'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { status: 200 });
      }

      if (isSummaryPreviewCall(call)) {
        return Response.json(
          { error: { message: "preview unavailable" } },
          { status: 429 },
        );
      }

      throw new Error(`Unexpected translation test request: ${JSON.stringify(call.body)}`);
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(requests.length, 2);
    assert.match(response.output, /event: delta/);
    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_stream_incomplete"/);
    assert.doesNotMatch(response.output, /event: translation_complete/);
    assert.doesNotMatch(response.output, /event: reasoning_summary\n/);
    assert.doesNotMatch(response.output, /event: done/);
  });

  it("retains preview and empty-final billing when the final text falls back locally", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const requests = [];
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);
      requests.push(call);

      if (isTranslationCall(call)) {
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });

        return new Response([
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { status: 200 });
      }

      if (isSummaryPreviewCall(call)) {
        return new Response([
          'data: {"choices":[{"delta":{"content":"- 预览摘要"},"finish_reason":null}]}',
          "",
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
          "",
          "data: [DONE]",
          "",
        ].join("\n"), { status: 200 });
      }

      if (isSummaryFinalCall(call)) {
        return Response.json({
          choices: [{
            finish_reason: "stop",
            message: { content: "" },
          }],
          usage: {
            completion_tokens: 1,
            prompt_tokens: 4,
            total_tokens: 5,
          },
        });
      }

      throw new Error(`Unexpected translation test request: ${JSON.stringify(call.body)}`);
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    const events = parseSseEvents(response.output);

    assert.equal(requests.length, 3);
    assert.equal(
      events.find((event) => event.eventName === "reasoning_summary")?.payload.source,
      "local",
    );
    assert.equal(
      events.filter((event) => event.eventName === "usage").at(-1)?.payload.totalTokens,
      21,
    );
    assert.match(response.output, /event: reasoning_summary_delta/);
    assert.match(response.output, /event: translation_complete/);
    assert.match(response.output, /event: done/);
  });

  it("aborts a pending final summary without writing a late snapshot after close", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    process.env.KIMI_API_KEY = "test-kimi-key";
    const finalStarted = createDeferred();
    let finalSignal;
    globalThis.fetch = async (url, init) => {
      const call = captureFetchCall(url, init);

      if (isTranslationCall(call)) {
        return createSuccessfulTranslationResponse({
          content: "你好",
          reasoningContent: "RAW_FINAL_ABORT_SECRET",
        });
      }

      if (isSummaryPreviewCall(call)) {
        return Response.json(
          { error: { message: "preview unavailable" } },
          { status: 429 },
        );
      }

      if (isSummaryFinalCall(call)) {
        finalSignal = init.signal;
        finalStarted.resolve();

        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }

      throw new Error(`Unexpected translation test request: ${JSON.stringify(call.body)}`);
    };
    const request = createReasoningFreeTranslationRequest("kimi-k3");
    const response = createTranslationResponse();
    const routePromise = handleTranslateStream(request, response);

    await finalStarted.promise;

    assert.match(response.output, /event: translation_complete/);
    response.emitClose();
    await routePromise;

    assert.equal(finalSignal.aborted, true);
    assert.doesNotMatch(response.output, /RAW_FINAL_ABORT_SECRET/);
    assert.doesNotMatch(response.output, /event: reasoning_summary\n/);
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

  it("uses a local summary without an extra call when thinking is enabled but DeepSeek is unavailable", async () => {
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
    const summary = events.find((event) => event.eventName === "reasoning_summary");

    assert.equal(fetchCalls, 1);
    assert.equal(summary?.payload.source, "local");
    assert.match(summary?.payload.text, /核心语义|翻译风格/);
    assert.doesNotMatch(response.output, /event: thinking/);
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

    assert.equal(response.statusCode, 200);
    assert.match(response.output, /"promptVersion":"free-translation-v1"/);
    assert.match(upstreamRequest.body.messages[0].content, /Auto-detect the source language/);
    assert.match(
      upstreamRequest.body.messages[1].content,
      /Source language: auto-detect from the source document/,
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
    assert.doesNotMatch(response.output, /event: thinking/);
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

function isSummaryPreviewCall(call) {
  return call?.body?.model === "deepseek-v4-flash" &&
    call.body.stream === true &&
    Number.isFinite(call.body.max_tokens) &&
    call.body.max_tokens <= 120;
}

function isSummaryFinalCall(call) {
  return call?.body?.model === "deepseek-v4-flash" &&
    call.body.stream === false;
}

function isTranslationCall(call) {
  return Boolean(call) &&
    !isSummaryPreviewCall(call) &&
    !isSummaryFinalCall(call);
}

function findTranslationCall(calls) {
  return calls.find(isTranslationCall);
}

function findSummaryPreviewCall(calls) {
  return calls.find(isSummaryPreviewCall);
}

function findSummaryFinalCall(calls) {
  return calls.find(isSummaryFinalCall);
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
