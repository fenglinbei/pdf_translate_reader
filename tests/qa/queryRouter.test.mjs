import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classifyQuestionType } from "../../server/qa/queryRouter.mjs";

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_QA_MODEL",
  "DEEPSEEK_API_BASE_URL",
  "GLM_API_KEY",
  "GLM_QA_MODEL",
  "GLM_API_BASE_URL",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function mockFetchReturn(content) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: {
      completion_tokens: 10,
      prompt_tokens: 20,
      total_tokens: 30,
    },
  }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;

  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("classifyQuestionType", () => {
  it("parses a valid global classification from the router LLM", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockFetchReturn('{"type":"global","confidence":"high","reason":"asks for a whole-paper summary"}');

    const result = await classifyQuestionType({
      model: "deepseek-v4-pro",
      question: "总结一下这篇论文",
    });

    assert.equal(result.type, "global");
    assert.equal(result.confidence, "high");
    assert.equal(result.fallback, undefined);
    assert.match(result.reason, /summary/);
  });

  it("tolerates markdown-fenced JSON", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockFetchReturn('```json\n{"type":"detail","confidence":"medium"}\n```');

    const result = await classifyQuestionType({
      model: "deepseek-v4-pro",
      question: "what is the formula on page 3",
    });

    assert.equal(result.type, "detail");
  });

  it("falls back to detail when the router returns an unsupported type", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    mockFetchReturn('{"type":"banana","confidence":"high"}');

    const result = await classifyQuestionType({
      model: "deepseek-v4-pro",
      question: "anything",
    });

    assert.equal(result.type, "detail");
    assert.equal(result.confidence, "low");
    assert.equal(result.fallback, true);
  });

  it("falls back to detail when the LLM call throws", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    const result = await classifyQuestionType({
      model: "deepseek-v4-pro",
      question: "anything",
    });

    assert.equal(result.type, "detail");
    assert.equal(result.confidence, "low");
    assert.equal(result.fallback, true);
    assert.match(result.reason, /Network connection/);
  });
});
