import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let vite, identity, usage;
before(async () => {
  vite = await createServer({ appType: 'custom', configFile: false, logLevel: 'silent', server: { middlewareMode: true } });
  identity = await vite.ssrLoadModule('/src/qa/sourceIdentity.ts');
  usage = await vite.ssrLoadModule('/src/qa/usageLogs.ts');
});
after(async () => { await vite?.close(); });
test('native citations match document, revision and evidence key; missing chunk IDs never match', () => {
  const a = { sourceKind: 'document_text', cloudDocumentId: 'd', sourceVersion: 'v', evidenceKey: 'k' };
  assert.equal(identity.sameQaSource(a, { ...a }), true);
  for (const change of [{ sourceVersion: 'v2' }, { evidenceKey: 'k2' }, { cloudDocumentId: 'd2' }]) assert.equal(identity.sameQaSource(a, { ...a, ...change }), false);
  assert.equal(identity.sameQaSource({}, {}), false);
  assert.equal(identity.sameQaSource(a, { cloudDocumentId: 'd', chunkId: 'old' }), false);
  assert.equal(identity.sameQaSource({ cloudDocumentId: 'd', chunkId: 'old' }, { cloudDocumentId: 'd', chunkId: 'old' }), true);
});
test('usage uses per-model calls exactly once, including failed calls, while preserving legacy final usage', () => {
  const rows = [{ id: 'a', messageId: 'new', requestKind: 'model-call', status: 'error' },
    { id: 'b', messageId: 'new', requestKind: 'model-call', status: 'success' },
    { id: 'c', messageId: 'new', requestKind: 'answer-stream' },
    { id: 'd', messageId: 'old', requestKind: 'answer-stream' },
    { id: 'e', messageId: 'paged', requestKind: 'answer-stream', payload: { usageAccounting: 'per-model-call' } }];
  assert.deepEqual(usage.qaLogsForUsage(rows).map(row => row.id), ['a', 'b', 'd']);
});
