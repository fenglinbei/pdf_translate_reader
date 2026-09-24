import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, it } from "node:test";
import { handleQaRoute } from "../../server/routes/qa.mjs";
import { QA_CHUNKER_VERSION } from "../../server/qa/config.mjs";
import { loadMathpixStructuredDocument } from "../../server/qa/documentParser.mjs";
import { loadCurrentPaperFullText } from "../../server/qa/retriever.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT_SHA = "a".repeat(64);
const SCOPE = { userId: USER_ID, userDocumentId: DOCUMENT_ID, contentSha256: CONTENT_SHA };
const FULL_MMD = "# Synthetic paper\n\nFull paper text with $x^2$ and a conclusion.";
const PAGES = [{ pageIndex: 0, lines: ["Synthetic paper", "Abstract", "Body text from the pages cache."] }];
const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_API_BASE_URL"];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let fixture;
let requests;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

// Exercise the actual Supabase query builder and row-to-DTO conversion. The
// service singleton retains this function; each test supplies a fresh fixture.
async function mockFetch(input, init) {
  const url = new URL(input);
  requests.push(url);
  if (fixture.route && url.origin === "https://model-fixture.invalid") {
    const body = JSON.parse(init.body);
    fixture.modelCalls.push(body);
    if (!body.stream) {
      if (fixture.retrievalFallback && fixture.modelCalls.length > 1) return json({ choices: [{ message: { content: '{"action":"direct_answer","reason":"test","replyOutline":"Synthetic reply"}' } }] });
      return json({ choices: [{ message: { content: JSON.stringify({ type: "global", confidence: "high" }) } }] });
    }
    if (!fixture.retrievalFallback) assert(body.messages.some((message) => message.content.includes(FULL_MMD)), "The answer model must receive the full paper.");
    if (fixture.fault === 'model') return json({ error: { message: 'Synthetic provider failure' } }, 400);
    if (fixture.fault === 'eof') return new Response('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n');
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Synthetic full-paper answer." } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  }
  assert.equal(url.origin, "https://qa-fixture.invalid");
  if (fixture.route && url.pathname === "/rest/v1/user_qa_threads") {
    const thread = { id: "thread-fixture", user_id: USER_ID, active_user_document_id: DOCUMENT_ID, scope: "current" };
    return json(init.method === "GET" ? [thread] : thread);
  }
  if (fixture.route && url.pathname === "/rest/v1/user_qa_messages") {
    if (init.method === "GET") return json([]);
    const body = JSON.parse(init.body);
    if (init.method === "POST") {
      const message = { id: `message-${body.role}`, ...body };
      fixture.messages.push(message);
      return json(message);
    }
    assert.equal(init.method, "PATCH");
    if (fixture.fault === 'persist' && body.status === 'success') return json({ message: 'Synthetic save failure' }, 503);
    assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
    const message = fixture.messages.find((item) => `eq.${item.id}` === url.searchParams.get("id"));
    assert(message);
    Object.assign(message, body);
    return json(message);
  }
  if (fixture.route && url.pathname === "/rest/v1/user_qa_api_logs") {
    assert.equal(init.method, "POST");
    const row = JSON.parse(init.body);
    fixture.logs.push(row);
    return json(row);
  }
  if (fixture.route && url.pathname === '/rest/v1/user_qa_agent_steps') {
    const row = { ...JSON.parse(init.body), id: `step-${(fixture.steps ??= []).length}` };
    fixture.steps.push(row); return json(row);
  }
  assert.equal(init.method, "GET");
  assert.equal(url.search.includes("undefined"), false, "A document scope field was lost before the database query.");

  if (url.pathname === "/rest/v1/user_documents") {
    assert.equal(url.searchParams.get("id"), `eq.${DOCUMENT_ID}`);
    assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
    assert.equal(url.searchParams.get("deleted_at"), "is.null");
    return json(fixture.documentVisible ? [{ id: DOCUMENT_ID, user_id: USER_ID, content_sha256: CONTENT_SHA }] : []);
  }
  if (url.pathname === "/rest/v1/user_qa_index_jobs") {
    assert.equal(url.searchParams.get("user_document_id"), `eq.${DOCUMENT_ID}`);
    assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
    return json([{
      id: "33333333-3333-4333-8333-333333333333",
      user_id: USER_ID,
      user_document_id: DOCUMENT_ID,
      content_sha256: CONTENT_SHA,
      status: fixture.indexStatus,
      chunker_version: QA_CHUNKER_VERSION,
      source: "mathpix-v3-pdf",
    }]);
  }
  if (url.pathname === "/rest/v1/user_mathpix_documents") {
    assert.equal(url.searchParams.get("user_id"), `eq.${USER_ID}`);
    assert.equal(url.searchParams.get("user_document_id"), `eq.${DOCUMENT_ID}`);
    assert.equal(url.searchParams.get("content_sha256"), `eq.${CONTENT_SHA}`);
    assert.equal(url.searchParams.get("status"), "eq.completed");
    assert.equal(url.searchParams.get("deleted_at"), "is.null");
    assert.equal(url.searchParams.get("pages_storage_path"), "not.is.null");
    return json(fixture.cachePresent ? [{
      pages_storage_path: "fixture/pages.json",
      full_mmd_storage_path: "fixture/full.mmd",
      status: "completed",
    }] : []);
  }
  if (url.pathname === "/storage/v1/object/user-mathpix/fixture/pages.json") return json(PAGES);
  if (url.pathname === "/storage/v1/object/user-mathpix/fixture/full.mmd") {
    return fixture.mmdAvailable
      ? new Response(FULL_MMD)
      : json({ message: "Synthetic missing MMD", statusCode: "404" }, 404);
  }
  assert.fail(`Unexpected request: ${url.pathname}`);
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://qa-fixture.invalid";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-key";
  process.env.DEEPSEEK_API_KEY = "synthetic-model-key";
  process.env.DEEPSEEK_API_BASE_URL = "https://model-fixture.invalid";
  globalThis.fetch = mockFetch;
  fixture = { documentVisible: true, indexStatus: "ready", cachePresent: true, mmdAvailable: true };
  requests = [];
});

it("completes the global route with full text, a saved answer and no retrieval fallback", async () => {
  Object.assign(fixture, { route: true, messages: [], modelCalls: [], logs: [] });
  const request = Readable.from([Buffer.from(JSON.stringify({
    activeDocumentId: DOCUMENT_ID,
    question: "Summarize this paper.",
    model: "deepseek-flash",
  }))]);
  request.method = "POST";
  const frames = [];
  const response = new EventEmitter();
  response.writeHead = (status) => { response.statusCode = status; response.headersSent = true; };
  response.flushHeaders = () => {};
  response.write = (frame) => { frames.push(frame); return true; };
  response.end = (frame) => { if (frame) frames.push(frame); response.writableEnded = true; response.emit("close"); };

  await handleQaRoute(request, response, new URL("http://localhost/api/qa/stream"), { id: USER_ID });

  const stream = frames.join("");
  assert.equal(response.statusCode, 200, stream);
  assert.match(stream, /event: done/);
  assert.doesNotMatch(stream, /event: error|"kind":"fallback"|"kind":"tool_call"/);
  assert.equal(fixture.modelCalls.length, 2, "Only classification and full-text answer calls are expected.");
  const answer = fixture.messages.find((message) => message.role === "assistant");
  assert.equal(answer.status, "success");
  assert.equal(answer.content, "Synthetic full-paper answer.");
  assert.equal(answer.retrieval_snapshot.retrieverVersion, "long-context");
  assert.equal(fixture.logs.length, 3);
  assert.equal(fixture.logs.filter(row => row.request_kind === 'model-call').length, 2);
  assert.equal(fixture.logs.find(row => row.request_kind === 'answer-stream').payload.longContext, true);
  assert.equal(answer.usage.promptTokens, 100);
  assert.deepEqual(fixture.steps.map(row => row.step_index), fixture.steps.map((_, index) => index));
  assert.equal(fixture.steps.filter(row => row.payload.terminal).length, 1);
});

for (const fault of ['model', 'eof', 'persist']) it(`legacy full-text ${fault} failure terminates without a second answer`, async () => {
  Object.assign(fixture, { route: true, messages: [], modelCalls: [], logs: [], fault });
  const request = Readable.from([Buffer.from(JSON.stringify({ activeDocumentId: DOCUMENT_ID, question: 'Summarize', model: 'deepseek-flash' }))]);
  request.method = 'POST';
  const frames = [], response = new EventEmitter();
  response.writeHead = () => { response.headersSent = true; };
  response.flushHeaders = () => {};
  response.write = frame => frames.push(frame);
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  await handleQaRoute(request, response, new URL('http://localhost/api/qa/stream'), { id: USER_ID });
  assert.match(frames.join(''), /event: error/);
  assert.doesNotMatch(frames.join(''), /event: done|"kind":"fallback"/);
  assert.equal(fixture.modelCalls.length, 2);
  const answer = fixture.messages.find(message => message.role === 'assistant');
  assert.equal(answer.status, 'error');
  if (fault === 'eof') assert.equal(answer.content, 'partial answer');
  if (fault === 'persist') assert.equal(answer.content, 'Synthetic full-paper answer.');
  assert.equal(fixture.steps.filter(step => step.payload.terminal).length, 1);
});

it('allowed cache failure preserves routing, fallback and retrieval steps with globally unique indices', async () => {
  Object.assign(fixture, { route: true, messages: [], modelCalls: [], logs: [], cachePresent: false, retrievalFallback: true });
  const request = Readable.from([Buffer.from(JSON.stringify({ activeDocumentId: DOCUMENT_ID, question: 'Summarize', model: 'deepseek-flash' }))]);
  request.method = 'POST';
  const frames = [], response = new EventEmitter();
  response.writeHead = () => { response.headersSent = true; };
  response.write = frame => frames.push(frame);
  response.end = () => { response.writableEnded = true; response.emit('close'); };
  await handleQaRoute(request, response, new URL('http://localhost/api/qa/stream'), { id: USER_ID });
  assert.match(frames.join(''), /event: done/);
  assert.equal(fixture.steps.filter(step => step.kind === 'fallback').length, 1);
  assert.deepEqual(fixture.steps.map(step => step.step_index), fixture.steps.map((_, index) => index));
  assert.equal(fixture.steps.filter(step => step.payload.terminal).length, 1);
  assert.equal(fixture.modelCalls.length, 3);
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

it("loads the full paper through the authenticated index DTO without losing document scope", async () => {
  const result = await loadCurrentPaperFullText({ ...SCOPE, model: "deepseek-flash" });
  assert.equal(result.text, FULL_MMD);
  assert.equal(result.truncated, false);
  assert.equal(requests.length, 5);
});

it("uses body pages when the optional full MMD cache cannot be downloaded", async () => {
  fixture.mmdAvailable = false;
  const result = await loadCurrentPaperFullText({ ...SCOPE, model: "deepseek-flash" });
  assert.equal(result.text, PAGES[0].lines.join(" "));
  assert.equal(result.truncated, false);
});

it("stops before reading an index or cache when the user cannot access the document", async () => {
  fixture.documentVisible = false;
  await assert.rejects(loadCurrentPaperFullText({ ...SCOPE, model: "deepseek-flash" }), { code: "qa_document_not_found" });
  assert.equal(requests.length, 1);
});

it("keeps the ready-index gate before loading full text", async () => {
  fixture.indexStatus = "pending";
  await assert.rejects(loadCurrentPaperFullText({ ...SCOPE, model: "deepseek-flash" }), { code: "qa_index_not_ready" });
  assert.equal(requests.length, 2);
});

it("does not read storage when no completed cache matches the exact document scope", async () => {
  fixture.cachePresent = false;
  await assert.rejects(loadCurrentPaperFullText({ ...SCOPE, model: "deepseek-flash" }), /MathPix parsing must be completed/);
  assert.equal(requests.some((url) => url.pathname.startsWith("/storage/")), false);
});

for (const field of Object.keys(SCOPE)) {
  it(`rejects missing or empty ${field} before making a database request`, async () => {
    for (const value of [undefined, null, "", "   ", 123]) {
      await assert.rejects(loadMathpixStructuredDocument({ ...SCOPE, [field]: value }), {
        name: "TypeError",
        message: `MathPix document input requires a non-empty ${field}.`,
      });
    }
    assert.equal(requests.length, 0);
  });
}
