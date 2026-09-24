import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createQaToolAdapter } from '../../server/chatModels/qaToolAdapter.mjs';
import { createDocumentView } from '../../server/qa/documents/view.mjs';
import { runDocumentPlanning } from '../../server/qa/documents/runtime.mjs';
import { createDocumentRunContext } from '../../server/qa/documents/runContext.mjs';
import { handleDocumentStream } from '../../server/qa/documents/stream.mjs';
import { loadDocumentSource } from '../../server/qa/documents/source.mjs';

const model = 'deepseek-flash';
const env = { DEEPSEEK_API_KEY: 'synthetic-key' };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const reply = (calls, extra = {}) => ({ choices: [{ finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: null, tool_calls: calls, ...extra } }] });
const source = () => ({ assertCurrent: async () => {}, view: createDocumentView({ documentId: 'doc', documentVersion: 'revision', sourceRecordId: 'record',
  pages: [{ lines: ['# Method', 'Gate weights fuse two branches.', '# Appendix', 'Temperature is 0.3.'] }] }) });
const finish = (ids = ['C1']) => ({ mode: ids.length ? 'grounded' : 'direct', citationSelections: ids.map(id => ({ kind: 'source', sourceEvidenceIds: [id] })), answerOutline: '' });
function fakeAdapter(turns) {
  const inputs = [];
  const adapter = createQaToolAdapter({ model, env, fetchImpl: async (_url, init) => {
    inputs.push(JSON.parse(init.body));
    assert(turns.length, 'unexpected model call');
    const next = turns.shift();
    if (next instanceof Error) throw next;
    return Response.json(next);
  } });
  return { adapter, inputs };
}
function context(extra = {}) {
  const logs = [], steps = [], tools = [], emitted = [];
  const value = createDocumentRunContext({ userId: 'user', userDocumentId: 'doc', messageId: 'message', threadId: 'thread', model,
    emit: (...event) => emitted.push(event), persistStep: async row => { steps.push(row); return { ...row, id: `s${row.stepIndex}` }; },
    persistTool: async row => { tools.push(row); return { ...row, id: `t${tools.length}` }; }, persistLog: async row => { logs.push(row); }, ...extra });
  return { value, logs, steps, tools, emitted };
}
async function plan(adapter, run = context(), overrides = {}) {
  return runDocumentPlanning({ source: source(), adapter, model, question: 'How does fusion work?', events: run.value.events,
    onModelCall: run.value.modelCall.bind(run.value), ...overrides });
}

test('native loop preserves complete assistant continuation and one result per call ID, including validation failures', async () => {
  const { adapter, inputs } = fakeAdapter([
    reply([call('a', 'read_document', { mode: 'full', userId: 'other' }), call('b', 'get_document_outline', {})], { reasoning_content: 'private continuation' }),
    reply([call('c', 'read_document', { mode: 'full' })]), reply([call('d', 'finish_reading', finish())]),
  ]);
  const run = context(); const result = await plan(adapter, run);
  assert.equal(inputs.length, 3);
  const second = inputs[1].messages;
  assert.equal(second[2].reasoning_content, 'private continuation');
  assert.deepEqual(second.filter(m => m.role === 'tool').map(m => m.tool_call_id), ['a', 'b']);
  assert.equal(JSON.parse(second[3].content).error.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(JSON.parse(second[4].content).ok, true);
  assert.equal(result.prepared.mode, 'grounded');
  assert.equal(JSON.stringify([...run.steps, ...run.logs, ...run.tools]).includes('private continuation'), false);
  assert.deepEqual(run.steps.map(s => s.stepIndex), run.steps.map((_, i) => i));
});

test('finish mixed with reads is rejected atomically then can be repaired', async () => {
  const { adapter, inputs } = fakeAdapter([reply([call('a', 'read_document', { mode: 'full' }), call('b', 'finish_reading', finish())]),
    reply([call('c', 'finish_reading', finish([]))])]);
  const result = await plan(adapter);
  assert.equal(result.store.evidence.length, 0);
  assert(inputs[1].messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).error.code === 'FINISH_MUST_BE_ALONE'));
});

test('repeated provider call IDs are fatal before a second execution', async () => {
  const { adapter } = fakeAdapter([reply([call('a', 'get_document_outline', {})]), reply([call('a', 'read_document', { mode: 'full' })])]);
  await assert.rejects(plan(adapter), { code: 'MODEL_PROTOCOL_ERROR' });
});

test('natural answers have one correction opportunity and cannot silently bypass finish', async () => {
  const { adapter, inputs } = fakeAdapter([reply([], { content: 'premature answer' }), reply([], { content: 'another answer' })]);
  await assert.rejects(plan(adapter), { code: 'MODEL_PROTOCOL_ERROR' });
  assert.equal(inputs.length, 2);
});

test('page parameter repair does not consume citation repair allowance and diagnostics omit quote text', async () => {
  const quote = value => ({ mode: 'grounded', citationSelections: [{ kind: 'quote', sourceEvidenceIds: ['C1'], quote: value }], answerOutline: '' });
  const { adapter, inputs } = fakeAdapter([
    reply([call('a', 'read_document', { mode: 'pages', pageStart: 5, pageEnd: 9 })]),
    reply([call('b', 'read_document', { mode: 'full' })]),
    reply([call('c', 'finish_reading', quote('private invented quote one'))]),
    reply([call('d', 'finish_reading', quote('private invented quote two'))]),
    reply([call('e', 'finish_reading', quote('Gate weights fuse two branches.'))]),
  ]);
  const run = context(); const result = await plan(adapter, run);
  assert.equal(result.stopReason, 'model_finish');
  assert.equal(inputs.length, 5);
  const failed = run.steps.filter(s => s.payload.citationDiagnostics);
  assert.equal(failed.length, 2);
  assert.equal(failed[0].payload.citationDiagnostics[0].reason, 'quote_text_not_found');
  assert.equal(failed[0].payload.citationDiagnostics[0].selectionIndex, 0);
  assert.equal(run.tools[2].input.selections[0].quoteHash.length, 64);
  assert.equal(JSON.stringify([...run.steps, ...run.tools, ...run.logs]).includes('private invented quote'), false);
});

test('citation repair remains bounded after three failed attempts', async () => {
  const bad = { mode: 'grounded', citationSelections: [{ kind: 'quote', sourceEvidenceIds: ['C1'], quote: 'missing' }], answerOutline: '' };
  const { adapter } = fakeAdapter([reply([call('a', 'read_document', { mode: 'full' })]),
    ...['b', 'c', 'd'].map(id => reply([call(id, 'finish_reading', bad)]))]);
  const result = await plan(adapter);
  assert.equal(result.stopReason, 'repair_budget');
  assert.equal(result.prepared.citations[0].selectionOrigin, 'budget_stop');
});

test('repeated cached reads stop with explicit budget-origin source citations', async () => {
  const { adapter } = fakeAdapter(['a', 'b', 'c'].map(id => reply([call(id, 'read_document', { mode: 'full' })])));
  const result = await plan(adapter);
  assert.equal(result.stopReason, 'no_progress');
  assert.equal(result.prepared.mode, 'insufficient');
  assert.equal(result.prepared.citations[0].selectionOrigin, 'budget_stop');
  assert.equal(result.metrics.cacheHits, 2);
});

test('cancellation after a tool result prevents another model request', async () => {
  const controller = new AbortController(); const run = context();
  const original = run.value.events.tool;
  run.value.events.tool = async value => { await original(value); controller.abort(); };
  const { adapter, inputs } = fakeAdapter([reply([call('a', 'read_document', { mode: 'full' })])]);
  await assert.rejects(plan(adapter, run, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(inputs.length, 1);
});

test('model usage aggregates all calls with token-weighted cache ratio and missing usage coverage', async () => {
  const run = context();
  await run.value.modelCall('planning', async () => run.value.events.modelUsage({ promptTokens: 100, completionTokens: 20, promptCacheHitTokens: 80 }));
  await run.value.modelCall('planning', async () => run.value.events.modelUsage({ promptTokens: 300, completionTokens: 40, promptCacheHitTokens: 120 }));
  await assert.rejects(run.value.modelCall('answer_generate', async () => { throw new Error('provider unavailable'); }));
  assert.equal(run.value.summary().cacheHitRatio, 0.5);
  assert.equal(run.value.summary().usageCoverage, 2 / 3);
  assert.equal(run.logs.length, 3);
  await run.value.terminal({ status: 'error', stopReason: 'provider_error' });
  await run.value.terminal({ status: 'error' });
  assert.equal(run.logs.filter(l => l.requestKind === 'answer-stream').length, 1);
  assert.equal(run.steps.filter(s => s.payload.terminal).length, 1);
});

test('provider adapter refuses unsupported models, duplicate IDs and incomplete decisions', async () => {
  assert.throws(() => createQaToolAdapter({ model: 'glm-5.3', env }), { code: 'UNSUPPORTED_DOCUMENT_TOOL_MODEL' });
  const duplicate = fakeAdapter([reply([call('a', 'get_document_outline', {}), call('a', 'get_document_outline', {})])]);
  await assert.rejects(duplicate.adapter.complete({ messages: [], tools: [] }), { code: 'MODEL_PROTOCOL_ERROR' });
  const truncated = fakeAdapter([{ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '' } }] }]);
  await assert.rejects(truncated.adapter.complete({ messages: [], tools: [] }), { code: 'MODEL_INCOMPLETE' });
  const malformed = createQaToolAdapter({ model, env, fetchImpl: async () => new Response('private malformed response') });
  await assert.rejects(malformed.complete({ messages: [], tools: [] }), error => error.code === 'MODEL_INVALID_RESPONSE' && !error.message.includes('private'));
});

test('answer stream rejects early EOF and new tool calls, preserves received text', async () => {
  for (const [suffix, code] of [['', 'MODEL_INCOMPLETE'], ['data: {"choices":[{"delta":{"tool_calls":[{}]}}]}\n\n', 'MODEL_PROTOCOL_ERROR']]) {
    const adapter = createQaToolAdapter({ model, env, fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' + suffix) });
    let text = '';
    await assert.rejects(adapter.stream({ messages: [], tools: [], onDelta: value => { text += value; } }), { code });
    assert.equal(text, 'partial');
  }
});

test('final stream disables new tools and reads provider cache usage without publishing private reasoning', async () => {
  let body, text = '', usage;
  const adapter = createQaToolAdapter({ model, reasoningEffort: 'standard', env, fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('data: {"choices":[{"delta":{"reasoning_content":"private","content":"Answer"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":64}}\n\ndata: [DONE]\n\n');
  } });
  await adapter.stream({ messages: [], tools: [], onDelta: value => { text += value; }, onUsage: value => { usage = value; } });
  assert.equal(body.tool_choice, 'none'); assert.equal(body.thinking.type, 'enabled');
  assert.equal(text, 'Answer'); assert.equal(usage.promptCacheHitTokens, 64);
});

class ResponseStub extends EventEmitter {
  headersSent = false; writableEnded = false; destroyed = false; output = '';
  writeHead(status) { this.headersSent = true; this.status = status; }
  write(text) { this.output += text; }
  end(text = '') { this.output += text; this.writableEnded = true; }
}
function routeSetup(fault) {
  const response = new ResponseStub(), updates = [], run = context(), counts = { complete: 0, stream: 0 };
  const { adapter } = fakeAdapter([reply([call('a', 'read_document', { mode: 'full' })]), reply([call('b', 'finish_reading', finish())])]);
  const deps = { createContext: options => { const value = context({ emit: options.emit }); Object.assign(run, value); return value.value; }, loadSource: async () => source(),
    createAdapter: () => ({ complete: async args => { counts.complete++; return adapter.complete(args); }, stream: async ({ onDelta, onUsage, signal }) => {
      counts.stream++; onDelta('Synthetic answer [C1]'); onUsage({ promptTokens: 100, completionTokens: 20 });
      if (fault === 'cancel') { response.destroyed = true; response.emit('close'); signal.throwIfAborted(); }
      if (fault === 'eof') throw Object.assign(new Error('incomplete answer'), { code: 'MODEL_INCOMPLETE' });
      if (fault === 'timeout') await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); setTimeout(resolve, 100); });
    } }),
    db: { createOrReuseQaThread: async () => ({ id: 'thread' }), listQaMessagesForThread: async () => [],
      insertQaMessage: async row => ({ ...row, id: row.role }), insertQaCitations: async ({ citations }) => { if (fault === 'persist') throw new Error('synthetic database failure'); return citations; },
      updateQaMessage: async row => { updates.push(row); return row; } }, ...(fault === 'timeout' ? { timeoutMs: 10 } : {}) };
  return { response, updates, run, counts, deps };
}

test('native stream persists citations, usage and one terminal before done', async () => {
  const test = routeSetup();
  await handleDocumentStream({}, test.response, { id: 'user' }, { model, question: 'Explain', activeDocumentId: 'doc' }, test.deps);
  assert(test.response.output.includes('event: done'));
  assert.equal(test.updates.at(-1).status, 'success');
  assert(test.response.output.includes('event: usage\ndata: {"promptTokens":100'));
  assert.equal(test.counts.stream, 1);
  assert.equal(test.run.logs.filter(l => l.requestKind === 'answer-stream').length, 1);
});
for (const fault of ['cancel', 'eof', 'persist', 'timeout']) test(`native ${fault} failure preserves partial text and never regenerates or falls back`, async () => {
  const test = routeSetup(fault);
  await handleDocumentStream({}, test.response, { id: 'user' }, { model, question: 'Explain', activeDocumentId: 'doc' }, test.deps);
  assert.equal(test.counts.complete, 2); assert.equal(test.counts.stream, 1);
  assert.equal(test.updates.at(-1).content, 'Synthetic answer [C1]');
  assert.equal(test.updates.at(-1).status, fault === 'cancel' ? 'aborted' : 'error');
  assert.equal(test.response.output.includes('event: done'), false);
  assert.equal(test.run.steps.filter(s => s.payload.terminal).length, 1);
});

test('source loader binds current owner/document/hash and rejects revision change on cache reuse', async () => {
  const filters = [], ownerChecks = [];
  let revision = '2026-09-24T00:00:00Z';
  const query = { select() { return this; }, eq(key, value) { filters.push([key, value]); return this; }, is() { return this; }, order() { return this; }, limit() { return this; },
    async maybeSingle() { return { data: { status: 'completed', content_sha256: 'hash', mathpix_options_hash: 'options', updated_at: revision, pages_storage_path: 'scoped/pages.json', num_pages: 1 } }; } };
  const client = { from(name) { assert.equal(name, 'user_mathpix_documents'); return query; }, storage: { from(bucket) { assert.equal(bucket, 'user-mathpix'); return {
    async download(path) { assert.equal(path, 'scoped/pages.json'); return { data: new Blob([JSON.stringify([{ lines: ['Text'] }])]) }; } }; } } };
  const value = await loadDocumentSource({ userId: 'owner', userDocumentId: 'document' }, { client,
    requireDocument: async scope => { ownerChecks.push(scope); return { content_sha256: 'hash', display_file_name: 'Synthetic' }; } });
  assert.equal(value.view.sourceRecordId, 'hash:options');
  assert(filters.some(([key, value]) => key === 'user_id' && value === 'owner'));
  assert(filters.some(([key, value]) => key === 'user_document_id' && value === 'document'));
  assert(filters.some(([key, value]) => key === 'content_sha256' && value === 'hash'));
  revision = '2026-09-24T01:00:00Z';
  await assert.rejects(value.assertCurrent(), { code: 'DOCUMENT_VERSION_CHANGED' });
  assert.equal(ownerChecks.length, 3);
});
