import test from 'node:test';
import assert from 'node:assert/strict';
import { QA_ANSWER_BUDGET } from '../../shared/qaAnswerBudget.mjs';
import { createArtifactWorkspace, validateArtifactTool } from '../../server/qa/documentArtifacts/tools.mjs';
import { validateWorkspaceTool } from '../../server/qa/workspace/tools.mjs';
import { createCitationStream } from '../../server/qa/documentArtifacts/citationStream.mjs';
import { createArtifactProtocol } from '../../server/qa/documentArtifacts/protocol.mjs';
import { runWorkspaceAgent } from '../../server/qa/workspace/runtime.mjs';

const ledger = { citation(ref, evidenceId) {
  if (!/^R([1-9][0-9]*)$/.test(ref) || Number(ref.slice(1)) > 200) throw Object.assign(new Error('unknown'), { code: 'UNKNOWN_READ_REFERENCE' });
  return { evidenceId, sourceKind: 'document_artifact', quotedText: `Evidence ${ref}` };
} };
test('discovery accepts omitted, empty and whitespace queries in both supported runtimes', async () => {
  const calls = [];
  const workspace = createArtifactWorkspace({ userId: 'alice', discover: async args => { calls.push(args); return { documents: [], hasMore: false }; } });
  for (const input of [{}, { query: '' }, { query: '   ' }]) {
    validateWorkspaceTool('discover_documents', input);
    validateArtifactTool('discover_documents', input);
    assert.deepEqual((await workspace.execute('discover_documents', input)).documents, []);
  }
  assert.equal(calls.length, 3);
  for (const input of [{ query: null }, { query: 1 }, { query: 'a'.repeat(201) }, { cursor: 'x', query: '' }]) {
    assert.throws(() => validateArtifactTool('discover_documents', input), { code: 'INVALID_TOOL_ARGUMENTS' });
  }
});
test('valid sources beyond 32 stream immediately; capacity, unknown and malformed refs stay distinct', () => {
  for (const count of [32, 33, 35, 128, 129]) {
    let deltas = '', metadata = [];
    const stream = createCitationStream({ ledger, messageId: 'm', attemptId: 1, onDelta: text => {
      for (const [, n] of text.matchAll(/\[C(\d+)\]/g)) assert(metadata.length >= Number(n));
      deltas += text;
    }, onCitations: citations => { metadata = citations; } });
    for (let i = 1; i <= count; i++) stream.push(`Fact ${i} [R${i}]. `);
    assert(deltas.startsWith('Fact 1 [C1]'));
    stream.push('Repeated [R1]. Unknown [R999]. Incomplete [R');
    const result = stream.finish();
    assert.equal(result.citations.length, Math.min(count, QA_ANSWER_BUDGET.maxCitations));
    assert.deepEqual(result.issues.map(i => i.code), [...(count > 128 ? ['CITATION_LIMIT'] : []), 'UNKNOWN_READ_REFERENCE', 'MALFORMED_REFERENCE']);
  }
});
async function run(answers, overrides = {}) {
  const events = [], requests = [], diagnostics = [], phases = [];
  const workspace = { ledger, metrics: { returnedChars: 100 }, assertCurrent: async () => {} };
  const protocol = createArtifactProtocol({ workspace, messageId: 'm' });
  const adapter = { async stream(options) {
    requests.push(options); const content = answers.shift(); assert(content, 'unexpected model invocation');
    for (let i = 0; i < content.length; i += 3) options.onDelta(content.slice(i, i + 3));
    return { message: { role: 'assistant', content }, calls: [] };
  } };
  const context = { modelCall: async (phase, fn) => { phases.push(phase); return fn(); }, events: {
    step: async (_kind, _summary, data) => diagnostics.push(data), modelUsage() {},
  } };
  const promise = runWorkspaceAgent({ adapter, workspace, protocol, context, model: 'deepseek-flash', question: 'Summarize.', userId: 'alice',
    onDelta: text => events.push(['delta', text]), onReset: () => events.push(['reset']), onAnswerUpdate: (answer, citations) => events.push(['update', answer, citations]), ...overrides });
  return { promise, events, requests, diagnostics, phases };
}
test('35 valid references finish in one generation with no repair or answer reset', async () => {
  const body = Array.from({ length: 35 }, (_, i) => `Claim ${i + 1} [R${i + 1}].`).join('\n');
  const r = await run([body]); const result = await r.promise;
  assert.equal(result.verified.citations.length, 35); assert.equal(r.requests.length, 1);
  assert(!r.events.some(e => e[0] !== 'delta')); assert.equal(result.metrics.repairedCitations, 0);
});
test('a single provider frame batches citation metadata before markers without quadratic SSE snapshots',()=>{
  const events=[],stream=createCitationStream({ledger,messageId:'m',attemptId:1,onDelta:t=>events.push(['delta',t]),onCitations:c=>events.push(['citations',c.length])});
  stream.push(Array.from({length:128},(_,i)=>`[R${i+1}]`).join(' '));
  assert.equal(stream.finish().citations.length,128);assert.equal(events.length,2);
  assert.deepEqual(events[0],['citations',128]);assert.match(events[1][1],/\[C128\]/);
});
test('repair updates only rejected markers and metadata, preserving prose and streamed text', async () => {
  const r = await run(['One claim [R1]. Another claim [R999].', '{"replacements":[{"from":"R999","to":"R2"}]}']);
  const result = await r.promise;
  assert.equal(result.answer, 'One claim [C1]. Another claim [C2].');
  assert.equal(r.events.filter(e => e[0] === 'update').length, 1); assert(!r.events.some(e => e[0] === 'reset'));
  assert.equal(r.events.filter(e => e[0] === 'delta').map(e => e[1]).join(''), 'One claim [C1]. Another claim .');
  assert.deepEqual(r.phases, ['agent_turn', 'citation_repair']);
  assert.equal(r.requests[1].tools, undefined); assert.equal(r.requests[1].maxTokens, 2048);
  assert.equal(r.diagnostics[0].issues[0].code, 'UNKNOWN_READ_REFERENCE'); assert(r.diagnostics[0].repaired);
});
test('failed repair and exhausted call budget retain the draft and never accept an unreturned source', async () => {
  for (const [repair, overrides, calls] of [
    ['{"replacements":[{"from":"R999","to":"R998"}]}', {}, 2],
    ['Here is a rewritten answer.', {}, 2],
    ['{"replacements":[]}', {}, 2],
    ['', { maxCalls: 1 }, 1],
    ['', { allowCitationUpdates: false }, 1],
  ]) {
    const r = await run(['Still visible [R1]. Unverified [R999].', repair], overrides);
    await assert.rejects(r.promise, { code: 'UNKNOWN_READ_REFERENCE' });
    assert.equal(r.requests.length, calls); assert(!r.events.some(e => e[0] === 'reset' || e[0] === 'update'));
  }
});
test('capacity overflow does not ask the model to rewrite and is never classified as unknown', async () => {
  const r = await run([Array.from({ length: 129 }, (_, i) => `[R${i + 1}]`).join(' ')]);
  await assert.rejects(r.promise, { code: 'CITATION_LIMIT' });
  assert.equal(r.requests.length, 1); assert(!r.events.some(e => e[0] === 'reset'));
  assert.equal(r.diagnostics[0].issues[0].code, 'CITATION_LIMIT');
});
