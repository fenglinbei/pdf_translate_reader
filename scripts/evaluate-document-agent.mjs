// Explicit live-provider evaluation. Does not read user documents or write DB.
// node --env-file=.env.qa.local scripts/evaluate-document-agent.mjs --model deepseek-flash --count 24 --output output/qa-p2/evaluation.json
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createQaToolAdapter } from '../server/chatModels/qaToolAdapter.mjs';
import { createDocumentView } from '../server/qa/documents/view.mjs';
import { runDocumentPlanning, assertContextBudget } from '../server/qa/documents/runtime.mjs';
import { DOCUMENT_TOOLS } from '../server/qa/documents/tools.mjs';
import { verifyDocumentAnswer } from '../server/qa/documents/citations.mjs';
import { documentAgentCases } from '../tests/fixtures/documentAgentCases.mjs';

const { values } = parseArgs({ options: { model: { type: 'string', default: 'deepseek-flash' }, effort: { type: 'string', default: 'quick' },
  count: { type: 'string', default: '24' }, offset: { type: 'string', default: '0' }, output: { type: 'string', default: 'output/qa-p2/evaluation.json' } } });
const count = Number(values.count), offset = Number(values.offset);
if (!Number.isInteger(count) || count < 1 || count > 24 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid fixture range');
const selected = documentAgentCases.slice(offset, offset + count), results = [];
const report = () => ({ generatedAt: new Date().toISOString(), scope: 'synthetic engineering evaluation; semantic quality requires human review',
  model: values.model, reasoningEffort: values.effort, requested: selected.length, results });
async function save() { const target = resolve(values.output); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(report(), null, 2) + '\n', { mode: 0o600 }); }
for (const fixture of selected) {
  const started = Date.now(), calls = [], events = []; let activeUsage, answer = '', firstAnswerMs;
  const adapter = createQaToolAdapter({ model: values.model, reasoningEffort: values.effort });
  const source = { view: createDocumentView({ pages: fixture.pages, title: fixture.title, documentId: fixture.id.split('-')[0], documentVersion: 'synthetic-v1', sourceRecordId: 'synthetic' }), assertCurrent: async () => {} };
  const hooks = { modelUsage: value => { activeUsage = value; }, step: async () => {}, tool: async value => events.push({ name: value.call.name, ok: value.result.ok, errorCode: value.result.error?.code, cacheHit: value.result.data?.cacheHit }) };
  async function onModelCall(phase, operation) {
    activeUsage = undefined; const start = Date.now(); let error;
    try { return await operation(); } catch (failure) { error = failure; throw failure; }
    finally { calls.push({ phase, elapsedMs: Date.now() - start, usage: activeUsage, errorCode: error?.code }); }
  }
  try {
    const signal = AbortSignal.timeout(300000);
    const result = await runDocumentPlanning({ source, adapter, model: values.model, question: fixture.question, signal, events: hooks, onModelCall });
    result.messages.push({ role: 'user', content: JSON.stringify({ instruction: 'Answer the question now. Cite only allowed IDs. State limits when evidence is insufficient.',
      mode: result.prepared.mode, allowedCitationIds: result.prepared.allowedCitationIds, answerOutline: result.prepared.answerOutline }) });
    assertContextBudget({ model: values.model, messages: result.messages, tools: DOCUMENT_TOOLS });
    await onModelCall('answer_generate', () => adapter.stream({ messages: result.messages, tools: DOCUMENT_TOOLS, signal,
      onDelta: text => { firstAnswerMs ??= Date.now() - started; answer += text; }, onUsage: hooks.modelUsage }));
    const verification = verifyDocumentAnswer(answer, result.prepared);
    results.push({ id: fixture.id, question: fixture.question, answer, elapsedMs: Date.now() - started, firstAnswerMs,
      citationProtocolPass: verification.valid, expectedKeywordPresent: fixture.expected ? answer.toLowerCase().includes(fixture.expected.toLowerCase()) : null,
      stopReason: result.stopReason, calls, tools: events, citations: verification.citations.map(c => ({ id: c.evidenceId, quote: c.quotedText, pageStart: c.pageStart, pageEnd: c.pageEnd, sectionPath: c.sectionPath, locationPrecision: c.locationPrecision })),
      metrics: result.metrics, warnings: verification.warnings });
    console.log(`${fixture.id}: citations=${verification.valid}, calls=${calls.length}, tools=${events.length}, elapsed=${Date.now() - started}ms`);
  } catch (error) {
    results.push({ id: fixture.id, question: fixture.question, answer, elapsedMs: Date.now() - started, errorCode: error.code ?? error.name, calls, tools: events });
    console.log(`${fixture.id}: failed ${error.code ?? error.name}`);
    if (/^MODEL_HTTP_(400|401|403|404)$/.test(error.code ?? '')) { await save(); break; }
  }
  await save();
}
console.log(`Saved ${results.length} synthetic results to ${values.output}`);
if (results.some(result => result.errorCode || !result.citationProtocolPass)) process.exitCode = 1;
