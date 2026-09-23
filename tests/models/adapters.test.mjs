import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { createQaChatCompletion, streamQaChatCompletion } from "../../server/chatModels/client.mjs";
import { createTranslationChatStream } from "../../server/translationModels/client.mjs";
import { createModelChatBody } from "../../server/models/requestBody.mjs";
import { getModelIds } from "../../shared/modelRegistry.mjs";
import { buildQaAnswerMessages } from "../../server/qa/prompt.mjs";

const originalFetch = globalThis.fetch;
const keys = ["ALIYUN_API_KEY", "DASHSCOPE_API_KEY", "ALIYUN_API_BASE_URL", "QWEN_API_BASE_URL", "DEEPSEEK_API_KEY", "GLM_API_KEY", "KIMI_API_KEY", "GLM_QA_MODEL"];
const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const messages = [{role: "user", content: "Translate Hello to Chinese."}];
beforeEach(() => {
  for (const key of keys) delete process.env[key];
  for (const key of ["ALIYUN_API_KEY", "DEEPSEEK_API_KEY", "GLM_API_KEY", "KIMI_API_KEY"]) process.env[key] = "test-key";
  process.env.ALIYUN_API_BASE_URL = "https://workspace.example/compatible-mode/v1";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
});

function captureRequest({stream = false, content = "你好", finish = "stop"} = {}) {
  const request = {};
  globalThis.fetch = async (url, init) => {
    Object.assign(request, {url, body: JSON.parse(init.body)});
    return new Response(stream ? [
      'data: {"choices":[{"delta":{"reasoning_content":"private trace"}}]}\n\n',
      `data: ${JSON.stringify({choices:[{delta:{content}, finish_reason:finish}]})}\n\n`,
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":12},"completion_tokens_details":{"reasoning_tokens":6},"total_tokens":30}}\n\n',
      'data: [DONE]\n\n',
    ].join("") : JSON.stringify({choices:[{message:{content,reasoning_content:"private trace"},finish_reason:finish}]}));
  };
  return request;
}

test("metadata extraction can cap output without changing the normal QA default", async () => {
  const request = captureRequest();
  await createQaChatCompletion({model:"deepseek-flash",messages,maxTokens:2200});
  assert.equal(request.body.max_tokens,2200);
  await createQaChatCompletion({model:"deepseek-flash",messages});
  assert.notEqual(request.body.max_tokens,2200);
});

for (const model of getModelIds().filter(id => !["deepseek-v4-flash","deepseek-v4-pro","glm-5.2"].includes(id))) {
  test(`${model}: translation and router use the selected provider and supported parameters`, async () => {
    const request = captureRequest();
    await createTranslationChatStream({model,messages,resolvedReasoning:{enabled:false,effort:"low"}});
    assert.equal(request.body.model, model);
    if (model.startsWith("qwen")) {
      assert.match(request.url, /^https:\/\/workspace\.example\/compatible-mode\/v1\/chat\/completions$/);
      assert.equal(request.body.enable_thinking, false);
      assert.equal("thinking" in request.body, false);
    } else if (model.startsWith("glm-5.3")) {
      assert.match(request.url, /bigmodel/);
      assert.deepEqual(request.body.thinking, {type:"enabled"});
      assert.equal(request.body.reasoning_effort,"low");
    } else if (model === "kimi-k3") {
      assert.match(request.url, /moonshot/);
      assert.equal(request.body.reasoning_effort,"low");
      assert.equal(request.body.max_completion_tokens,16384);
      for (const field of ["thinking","temperature","max_tokens","top_p"]) assert.equal(field in request.body,false);
    } else {
      assert.match(request.url,/deepseek/);
      assert.deepEqual(request.body.thinking,{type:"disabled"});
    }
    const response = await createQaChatCompletion({model,messages});
    assert.equal(response.content,"你好");
    assert.equal("reasoning_content" in response,false);
    assert.equal(request.body.model,model);
    assert.equal(request.body.stream,false);
    if (model.startsWith("glm-5.3") || model === "kimi-k3") {
      assert.equal(request.body.reasoning_effort,"low");
      assert.notDeepEqual(request.body.thinking,{type:"disabled"});
      assert.equal("temperature" in request.body,false);
    }
  });
}

test("Qwen effort mapping uses medium/xhigh and sends no extra_body or thinking_budget", async () => {
  for (const [effort, expected] of [["high","medium"],["max","xhigh"]]) {
    const request = captureRequest();
    await createTranslationChatStream({model:"qwen3.8-max",messages,resolvedReasoning:{enabled:true,effort}});
    assert.equal(request.body.reasoning_effort,expected);
    assert.equal(request.body.enable_thinking,true);
    for (const field of ["thinking","thinking_budget","extra_body","temperature"]) assert.equal(field in request.body,false);
  }
});

test("Qwen without workspace URL fails before any HTTP request", async () => {
  delete process.env.ALIYUN_API_BASE_URL;
  let called = false;
  globalThis.fetch = async () => {called=true; throw Error("unexpected");};
  for (const client of [createTranslationChatStream,createQaChatCompletion]) {
    await assert.rejects(client({model:"qwen3.8-flash",messages}), error=>error.code==="qwen_api_base_url_missing");
  }
  assert.equal(called,false);
});

test("unknown model IDs never silently route an API call to the default provider", async () => {
  for (const client of [createTranslationChatStream,createQaChatCompletion]) {
    await assert.rejects(client({model:"kimi-k2.7-code-highspeed",messages}), error=>error.statusCode===400);
  }
});

test("legacy provider override cannot relabel a GLM 5.3 call as another model", async () => {
  process.env.GLM_QA_MODEL="glm-5.2";
  const request=captureRequest();
  await createQaChatCompletion({model:"glm-5.3",messages});
  assert.equal(request.body.model,"glm-5.3");
  assert.deepEqual(request.body.thinking,{type:"enabled"});
});

test("QA stream separates answer and reasoning, and reads nested cache/reasoning usage", async () => {
  const request=captureRequest({stream:true});
  let answer="", thinking="", usage;
  await streamQaChatCompletion({model:"kimi-k3",messages,reasoningEffort:"standard",onDelta:t=>answer+=t,onThinking:t=>thinking+=t,onUsage:u=>usage=u});
  assert.equal(answer,"你好");
  assert.equal(thinking,"private trace");
  assert.equal(request.body.reasoning_effort,"high");
  assert.equal(request.body.max_completion_tokens,32768);
  assert.equal("max_tokens" in request.body,false);
  assert.equal(usage.promptCacheHitTokens,12);
  assert.equal(usage.reasoningTokens,6);
});

test("QA rejects truncated, empty and interrupted streams", async () => {
  for (const [options,code] of [[{finish:"length"},"qa_output_truncated"],[{content:""},"qa_empty_response"],[{finish:null},"qa_incomplete_response"]]) {
    captureRequest({stream:true,...options});
    await assert.rejects(streamQaChatCompletion({model:"glm-5.3-flash",messages}),error=>error.code===code);
  }
});

test("QA stream errors cancel the upstream reader and do not echo malformed data", async () => {
  for (const data of ['{"error":{"message":"upstream failed"}}', 'malformed-private-payload']) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`)); },
      cancel() { cancelled = true; },
    }));
    await assert.rejects(streamQaChatCompletion({model:"qwen3.8-max",messages}), error => {
      assert.ok(["qa_stream_error","qa_invalid_stream"].includes(error.code));
      assert.doesNotMatch(error.message,/malformed-private-payload/);
      return true;
    });
    assert.equal(cancelled,true);
  }
});

test("wire adapter enforces effort and output bounds", () => {
  assert.throws(()=>createModelChatBody({model:"kimi-k3",messages,maxTokens:2_000_000}),/Invalid output token/);
  assert.throws(()=>createModelChatBody({model:"glm-5.3",messages,thinking:{enabled:true,effort:"none"}}),/Unsupported reasoning effort/);
});

test("QA follow-up context stays inside a fresh user prompt, without incomplete assistant messages", () => {
  const prompt=buildQaAnswerMessages({question:"继续解释",chatContext:{recentMessages:[{role:"assistant",content:"先前回答"}]},evidence:[]});
  assert.deepEqual(prompt.map(message=>message.role),["system","user"]);
  assert.match(prompt[1].content,/先前回答/);
});
