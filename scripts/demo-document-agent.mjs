import { createDocumentView } from '../server/qa/documents/view.mjs';
import { runDocumentPlanning } from '../server/qa/documents/runtime.mjs';
import { documentAgentCases } from '../tests/fixtures/documentAgentCases.mjs';

const fixture = documentAgentCases[0];
const view = createDocumentView({ ...fixture, documentId: 'synthetic', documentVersion: 'demo-v1', sourceRecordId: 'demo' });
const turns = [
  { name: 'read_document', args: { mode: 'full' } },
  { name: 'finish_reading', args: { mode: 'grounded', citationSelections: [{ kind: 'quote', sourceEvidenceIds: ['C1'], quote: 'Gate weights fuse two branches using a softmax function.' }], answerOutline: '解释 softmax 门控融合。' } },
];
let turn = 0;
const result = await runDocumentPlanning({ source: { view, assertCurrent: async () => {} }, model: 'deepseek-flash', question: fixture.question,
  adapter: { complete: async ({ messages }) => {
    const { name, args } = turns[turn++], id = `demo-${turn}`;
    console.log(JSON.stringify({ modelTurn: turn, messageRoles: messages.map(m => m.role), toolResultIds: messages.filter(m => m.role === 'tool').map(m => m.tool_call_id) }));
    return { message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, calls: [{ id, name, arguments: JSON.stringify(args) }] };
  } }, onModelCall: async (_phase, operation) => operation(),
  events: { modelUsage() {}, step: async (_kind, summary) => console.log(summary),
    tool: async ({ call, result }) => console.log(JSON.stringify({ callId: call.id, tool: call.name, result })) } });
console.log(JSON.stringify({ finalAllowedCitationIds: result.prepared.allowedCitationIds,
  harnessMapping: result.prepared.citations.map(({ evidenceId, quotedText, sectionPath, sourceSpans, lineRegions }) => ({ evidenceId, quotedText, sectionPath, sourceSpans, lineRegions })) }, null, 2));
