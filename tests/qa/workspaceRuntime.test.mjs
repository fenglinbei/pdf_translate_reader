import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkspaceTools } from '../../server/qa/workspace/tools.mjs';
import { runWorkspaceAgent, createWorkspaceMessages } from '../../server/qa/workspace/runtime.mjs';
import { createDocumentView } from '../../server/qa/documents/view.mjs';
import { createDocumentRunContext } from '../../server/qa/documents/runContext.mjs';
import { createQaToolAdapter } from '../../server/chatModels/qaToolAdapter.mjs';
import { normalizeQaStreamRequest } from '../../server/routes/qa.mjs';

function setup() {
  const loaded = [], logs = [], steps = [], emitted = [];
  const workspace = createWorkspaceTools({ userId: 'owner', activeDocumentId: 'a',
    discover: async ({ userId }) => { assert.equal(userId, 'owner'); return { documents: [{ id: 'a', title: 'Alpha', isCurrent: true }, { id: 'b', title: 'Beta' }], hasMore: false }; },
    loadSource: async ({ userId, userDocumentId }) => {
      assert.equal(userId, 'owner'); loaded.push(userDocumentId);
      return { assertCurrent: async () => {}, view: createDocumentView({ documentId: userDocumentId, documentVersion: 'v1', title: userDocumentId,
        pages: [{ lines: ['# Method', userDocumentId === 'a' ? 'Alpha uses gating.' : 'Beta uses attention.'] }] }) };
    } });
  const context = createDocumentRunContext({ userId: 'owner', messageId: 'message', threadId: 'thread', model: 'deepseek-flash', runtimeVersion: 'workspace-tools-v1', duplicateObservations: false, recordToolTrace: true,
    emit: (...event) => emitted.push(event), persistStep: async row => { steps.push(row); return { ...row, id: `s${row.stepIndex}` }; },
    persistTool: async row => row, persistLog: async row => logs.push(structuredClone(row)) });
  return { workspace, context, loaded, logs, steps, emitted };
}
const tool = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function adapter(turns) {
  const requests = [];
  return { requests, adapter: createQaToolAdapter({ model: 'deepseek-flash', env: { DEEPSEEK_API_KEY: 'synthetic' }, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const message = turns.shift(); assert(message, 'unexpected model call');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', ...message, tool_calls: message.tool_calls?.map((call, index) => ({ ...call, index })) }, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
  } }) };
}
test('ordinary questions with and without focus use one native call, zero source access; public trace excludes private reasoning', async () => {
  for (const activeDocumentId of ['a', undefined]) {
    const run = setup(); const fake = adapter([{ content: '我是 DeepSeek V4.1 Flash。', reasoning_content: 'private-continuation' }]);
    const result = await runWorkspaceAgent({ ...run, adapter: fake.adapter, model: 'deepseek-flash', question: '你是什么模型', activeDocumentId });
    assert.equal(result.metrics.toolCalls, 0); assert.equal(fake.requests.length, 1); assert.deepEqual(run.loaded, []);
    const trace = run.logs[0].payload.publicTrace;
    assert.equal(trace.request.messages.at(-1).content, '你是什么模型');
    assert.equal(trace.request.tools.length, 5);
    assert(!JSON.stringify(run.logs).includes('private-continuation'));
    assert.equal(trace.privateContinuation, 'not_stored_not_byte_exact_replay');
  }
});
test('multi-document sources are globally unique, citations incremental and cross-document quotes rejected', async () => {
  const { workspace, loaded } = setup();
  await workspace.execute('discover_documents', {}); assert.equal(loaded.length, 0);
  const a = await workspace.execute('read_document', { document: 'D1' });
  const b = await workspace.execute('read_document', { document: 'D2' });
  assert.equal(a.evidence[0].source, 'R1'); assert.equal(b.evidence[0].source, 'R2');
  await assert.rejects(workspace.execute('cite_sources', { selections: [{ sources: ['R1', 'R2'] }] }), { code: 'CROSS_DOCUMENT_QUOTE' });
  await workspace.execute('cite_sources', { selections: [{ sources: ['R1'], quote: 'Alpha uses gating.' }] });
  await workspace.execute('read_document', { source: 'R2' });
  const selected = await workspace.execute('cite_sources', { selections: [{ sources: ['R2'], quote: 'Beta uses attention.' }] });
  assert.equal(selected.citations[0].citation, 'C2');
  assert.deepEqual(workspace.citations.map(c => [c.evidenceId, c.cloudDocumentId]), [['C1', 'a'], ['C2', 'b']]);
  await assert.rejects(workspace.execute('cite_sources', { selections: [{ sources: ['R9'] }] }), { code: 'UNKNOWN_EVIDENCE' });
  await assert.rejects(workspace.execute('read_document', { document: 'other-user-uuid' }), { code: 'UNKNOWN_DOCUMENT' });
});
test('natural loop emits progress, preserves continuation, returns tool errors, and needs no finish or answer-only turn', async () => {
  const run = setup(); const fake = adapter([
    { content: '我先查看方法部分。', reasoning_content: 'private', tool_calls: [tool('1', 'read_document', { document: 'current', pageStart: 1 })] },
    { tool_calls: [tool('2', 'read_document', { document: 'current' })] },
    { tool_calls: [tool('3', 'cite_sources', { selections: [{ sources: ['R1'], quote: 'Alpha uses gating.' }] })] },
    { content: '使用门控。[C1]' },
  ]);
  let resets = 0;
  const result = await runWorkspaceAgent({ ...run, adapter: fake.adapter, model: 'deepseek-flash', question: '如何实现', activeDocumentId: 'a', onReset: () => resets++ });
  assert.equal(fake.requests.length, 4); assert.equal(result.verified.citations.length, 1); assert.equal(resets, 3);
  assert.equal(fake.requests[1].messages.find(m => m.role === 'assistant').reasoning_content, 'private');
  assert.equal(JSON.parse(fake.requests[1].messages.at(-1).content).error.code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(run.steps.filter(s => s.kind === 'tool_call').length, 3);
  assert.equal(run.steps.filter(s => s.kind === 'observation').length, 0);
  assert.equal(run.steps.filter(s => s.kind === 'commentary').length, 1);
  assert.equal(run.logs.filter(l => l.payload.phase === 'tool_result').length, 3);
});
test('workspace input preserves multiline user question and conversation history roles', () => {
  const body = normalizeQaStreamRequest({ scope: 'workspace', question: 'first\nsecond' });
  assert.equal(body.question, 'first\nsecond');
  const messages = createWorkspaceMessages({ model: 'deepseek-flash', question: 'next', recentMessages: [{ role: 'user', status: 'success', content: 'earlier' }, { role: 'assistant', status: 'success', content: 'answer' }] });
  assert.deepEqual(messages.slice(1, 3).map(m => m.role), ['user', 'assistant']);
});
