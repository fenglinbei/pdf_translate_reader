import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createTranslationChatStream,
  normalizeTranslationModel,
  TranslationModelError,
} from "../../server/translationModels/client.mjs";
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

  it("forwards only translated content while preserving Kimi usage", async () => {
    process.env.KIMI_API_KEY = "test-kimi-key";
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"reasoning_content":"hidden reasoning"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cached_tokens":3}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });
    const request = createTranslationRequest({
      contextWindowN: 0,
      localContextAfter: [],
      localContextBefore: [],
      longContextEnabled: false,
      model: "kimi-k3",
      requestKind: "selection",
      sourceLang: "en",
      stream: true,
      targetLang: "zh",
      targetSentence: "Hello",
      translationStyle: { presetId: "academic-faithful" },
    });
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.equal(response.statusCode, 200);
    assert.equal(response.ended, true);
    assert.match(response.output, /event: meta/);
    assert.match(response.output, /event: heartbeat/);
    assert.match(response.output, /"model":"kimi-k3"/);
    assert.match(response.output, /event: delta\ndata: \{"text":"你好"\}/);
    assert.match(response.output, /"promptCacheHitTokens":3/);
    assert.match(response.output, /"promptCacheMissTokens":7/);
    assert.match(response.output, /event: finish/);
    assert.match(response.output, /event: done/);
    assert.doesNotMatch(response.output, /hidden reasoning/);
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
      'data: {"error":{"code":"provider_failure","message":"stream failed"}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"), { status: 200 });
    const request = createTranslationRequest(createRequestBody("glm-5.2"));
    const response = createTranslationResponse();

    await handleTranslateStream(request, response);

    assert.match(response.output, /event: error/);
    assert.match(response.output, /"code":"translation_upstream_stream_error"/);
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

function createTranslationResponse() {
  const listeners = new Map();

  return {
    ended: false,
    headersSent: false,
    output: "",
    statusCode: undefined,
    writableEnded: false,
    end() {
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
