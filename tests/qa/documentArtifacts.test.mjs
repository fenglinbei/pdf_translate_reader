import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentRevision, createNodeId, validateDocumentArtifact, sealDocumentArtifact,
  resolveDocumentLocation, getSectionPath, ARTIFACT_LIMITS } from '../../shared/qaDocumentArtifact.mjs';
import { createReadReferenceRegistry } from '../../server/qa/documentArtifacts/readReferences.mjs';
import { createArtifactPartCache } from '../../server/qa/documentArtifacts/partCache.mjs';
import { documentArtifactFixture } from '../fixtures/documentArtifacts.mjs';

const scope = { userId: 'user-a', runId: 'run-a' };
async function setup() {
  const fixture = await documentArtifactFixture();
  return { ...fixture, sealed: await sealDocumentArtifact(fixture.artifact) };
}
const read = (artifact, node, extra = {}) => ({ artifact, documentId: 'doc-a', nodeId: node.id, ...extra });

test('content revisions ignore object key order, and change with parser or mapping inputs', async () => {
  const { artifact } = await setup();
  const reordered = Object.fromEntries(Object.entries(artifact.source).reverse());
  assert.equal(await createDocumentRevision(reordered), artifact.revision);
  for (const change of [{ pdfSha256: '4'.repeat(64) }, { mmdSha256: '4'.repeat(64) },
    { pagesSha256: '4'.repeat(64) }, { builderVersion: 'fixture-2' }, { mappingVersion: 'fixture-2' }]) {
    assert.notEqual(await createDocumentRevision({ ...artifact.source, ...change }), artifact.revision);
  }
  await assert.rejects(createDocumentRevision({ ...artifact.source, updatedAt: Date.now() }), { code: 'INVALID_ARTIFACT' });
});

test('repeated content has occurrence identities and retains distinct physical positions', async () => {
  const { sealed, word, repeated } = await setup();
  assert.notEqual(word.id, repeated.id);
  assert.equal(createNodeId('paragraph', word.sourceRange), word.id);
  assert.equal(resolveDocumentLocation(sealed, word.id).anchor.pageNumber, 1);
  assert.equal(resolveDocumentLocation(sealed, repeated.id).anchor.pageNumber, 2);
});

test('canonical moderate maps to the two original lines without model quote matching', async () => {
  const { sealed, word } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  const [item] = ledger.registerBatch([read(sealed, word)]);
  assert.equal(item.text, 'moderate');
  const citation = ledger.resolve(item.ref, scope);
  assert.equal(citation.location.precision, 'line');
  assert.deepEqual(citation.location.sourceSpans.map(part => part.regionId), ['p1_l1', 'p1_l2']);
  assert.deepEqual(citation.sectionPath, ['Experiments', 'Human Audit']);
  assert.equal(citation.text, 'moderate');
});

test('partial reads cannot widen logical evidence or silently pick another sentence', async () => {
  const { sealed, para } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  const [item] = ledger.registerBatch([read(sealed, para, { range: [13, 24] })]);
  assert.equal(item.coverage, 'partial');
  assert.equal(item.text, 'Next claim.');
  const citation = ledger.resolve(item.ref, scope);
  assert.deepEqual(citation.range, [13, 24]);
  assert.equal(citation.location.anchor.pageNumber, 2);
  assert.deepEqual(citation.location.sourceSpans.map(part => part.regionId), ['p2_l3']);
  assert.throws(() => ledger.resolve('R2', scope), { code: 'UNKNOWN_READ_REFERENCE' });
  assert.throws(() => ledger.registerBatch([read(sealed, para, { range: [12, 13] })]), { code: 'EMPTY_READ_RANGE' });
});

test('a partial selection inside a coarse multi-line map does not claim precise lines', async () => {
  const { sealed, word } = await setup();
  const location = resolveDocumentLocation(sealed, word.id, [3, 8]);
  assert.equal(location.precision, 'page');
  assert.equal(location.mappingComplete, false);
  assert.deepEqual(location.lineRegions, []);
});

test('whole-table location is a block, and a table slice needs a finer map', async () => {
  const { sealed, table } = await setup();
  assert.equal(resolveDocumentLocation(sealed, table.id).precision, 'block');
  assert.equal(resolveDocumentLocation(sealed, table.id, [7, 12]).precision, 'page');
});

test('reading a heading never grants its descendants as evidence', async () => {
  const { sealed, heading, para } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  assert.throws(() => ledger.registerBatch([read(sealed, heading)]), { code: 'NAVIGATION_IS_NOT_EVIDENCE' });
  assert.deepEqual(ledger.metrics, { references: 0, returnedChars: 0 });
  assert.deepEqual(getSectionPath(sealed, para.id), ['Experiments']);
});

test('user/run scope, document identity and document revision cannot be confused', async () => {
  const { artifact, sealed, word } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  const [a, b] = ledger.registerBatch([read(sealed, word), read(sealed, word, { documentId: 'doc-b' })]);
  assert.notEqual(a.ref, b.ref);
  assert.equal(ledger.resolve(b.ref, scope).documentId, 'doc-b');
  assert.throws(() => ledger.resolve(a.ref, { ...scope, userId: 'user-b' }), { code: 'READ_SCOPE_MISMATCH' });
  assert.throws(() => ledger.resolve(a.ref, { ...scope, runId: 'run-b' }), { code: 'READ_SCOPE_MISMATCH' });
  artifact.source.mappingVersion = 'fixture-2'; artifact.revision = await createDocumentRevision(artifact.source);
  const next = await sealDocumentArtifact(artifact);
  assert.throws(() => ledger.registerBatch([read(next, word)]), { code: 'DOCUMENT_REVISION_CHANGED' });
  const equivalent = await sealDocumentArtifact(structuredClone(sealed));
  assert.throws(() => ledger.registerBatch([read(equivalent, word)]), { code: 'DOCUMENT_SNAPSHOT_CHANGED' });
  const fresh = createReadReferenceRegistry({ ...scope, runId: 'run-b' });
  assert.throws(() => fresh.resolve(a.ref, { ...scope, runId: 'run-b' }), { code: 'UNKNOWN_READ_REFERENCE' });
  const [c] = fresh.registerBatch([read(next, word)]);
  assert.notEqual(ledger.resolve(a.ref, scope).revision, fresh.resolve(c.ref, { ...scope, runId: 'run-b' }).revision);
});

test('repeated reads keep a handle while repeated text still consumes prompt budget', async () => {
  const { sealed, word } = await setup();
  const ledger = createReadReferenceRegistry({ ...scope, maxReturnedChars: 16 });
  const [a] = ledger.registerBatch([read(sealed, word)]);
  const [b] = ledger.registerBatch([read(sealed, word)]);
  assert.equal(a.ref, b.ref);
  assert.deepEqual(ledger.metrics, { references: 1, returnedChars: 16 });
  assert.throws(() => ledger.registerBatch([read(sealed, word)]), { code: 'READ_BUDGET_EXHAUSTED' });
  assert.deepEqual(ledger.metrics, { references: 1, returnedChars: 16 });
});

test('failed batches publish no handles and consume no budget', async () => {
  const { sealed, word, repeated, para } = await setup();
  const ledger = createReadReferenceRegistry({ ...scope, maxReturnedChars: 20, maxReferences: 2 });
  assert.throws(() => ledger.registerBatch([read(sealed, word), read(sealed, para)]), { code: 'READ_BUDGET_EXHAUSTED' });
  assert.throws(() => ledger.registerBatch([read(sealed, word), read(sealed, para, { range: [0, 999] })]), { code: 'INVALID_TEXT_RANGE' });
  assert.deepEqual(ledger.metrics, { references: 0, returnedChars: 0 });
  assert.equal(ledger.registerBatch([read(sealed, repeated)])[0].ref, 'R1');
});

test('source and logical ranges reject split surrogate pairs while preserving NFC provenance', async () => {
  const { sealed, unicode, artifact } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  assert.throws(() => ledger.registerBatch([read(sealed, unicode, { range: [1, 2] })]), { code: 'INVALID_TEXT_RANGE' });
  const [item] = ledger.registerBatch([read(sealed, unicode)]);
  assert.equal(item.text, 'A😀 café');
  assert.equal(ledger.resolve(item.ref, scope).location.sourceSpans[0].endOffset, 9);
  artifact.mappings.find(item => item.nodeId === unicode.id).segments[0].sources[0].range = [0, 2];
  assert.throws(() => validateDocumentArtifact(artifact), { code: 'INVALID_TEXT_RANGE' });
});

test('issued references cannot change when the original inputs or returned values are edited', async () => {
  const { artifact, sealed, word } = await setup();
  const ledger = createReadReferenceRegistry(scope);
  const input = read(sealed, word, { range: [0, 8] });
  const [item] = ledger.registerBatch([input]);
  artifact.nodes.find(node => node.id === word.id).text = 'changed';
  input.range[1] = 1;
  item.text = 'changed';
  const citation = ledger.resolve(item.ref, scope);
  citation.range[1] = 1; citation.location.sourceSpans[0].startOffset = 99;
  assert.equal(ledger.resolve(item.ref, scope).text, 'moderate');
  assert.deepEqual(ledger.resolve(item.ref, scope).range, [0, 8]);
  assert.equal(ledger.resolve(item.ref, scope).location.sourceSpans[0].startOffset, 0);
  assert.throws(() => { sealed.regions[0].rect.x = 0.9; }, TypeError);
});

test('missing regions and unlocated nodes do not fabricate precise references', async () => {
  const { artifact, word, para } = await documentArtifactFixture();
  delete artifact.regions[1].rect;
  artifact.mappings = artifact.mappings.filter(item => item.nodeId !== para.id);
  const sealed = await sealDocumentArtifact(artifact);
  assert.equal(resolveDocumentLocation(sealed, word.id).precision, 'partial-line');
  assert.equal(resolveDocumentLocation(sealed, para.id).precision, 'unavailable');
  assert.equal(resolveDocumentLocation(sealed, para.id).anchor, undefined);
  artifact.mappings.push({ nodeId: para.id, segments: [], pageAnchor: 2 });
  assert.equal(resolveDocumentLocation(await sealDocumentArtifact(artifact), para.id).precision, 'page');
});

test('unmapped non-whitespace gaps do not claim complete source coverage', async () => {
  const { artifact, para } = await documentArtifactFixture();
  artifact.mappings.find(item => item.nodeId === para.id).segments.pop();
  const location = resolveDocumentLocation(await sealDocumentArtifact(artifact), para.id);
  assert.equal(location.mappingComplete, false);
  assert.equal(location.precision, 'partial-line');
});

test('shape validation rejects dangling nodes, ambiguous maps, cycles, invalid coordinates and oversized inputs', async () => {
  const { artifact, word, audit } = await documentArtifactFixture();
  const variants = [
    value => { value.nodes[2].parentId = 'missing'; },
    value => { value.nodes[1].parentId = audit.id; },
    value => { value.nodes.push({ ...value.nodes[2] }); },
    value => { value.regions[0].rect.x = 2; },
    value => { value.mappings[0].segments[0].sources[0].regionId = 'missing'; },
    value => { value.regions[2].text = 'invented'; },
    value => { value.mappings.push({ nodeId: word.id, segments: [] }); },
    value => { value.mappings[0].segments.push(value.mappings[0].segments[0]); },
    value => { value.nodes = Array(ARTIFACT_LIMITS.maxNodes + 1).fill(value.nodes[2]); },
    value => { value.nodes[2].text = 'x'.repeat(ARTIFACT_LIMITS.maxTextChars + 1); },
  ];
  for (const mutate of variants) {
    const value = structuredClone(artifact); mutate(value);
    assert.throws(() => validateDocumentArtifact(value));
  }
  const wrongRevision = { ...artifact, revision: 'a'.repeat(64) };
  await assert.rejects(sealDocumentArtifact(wrongRevision), { code: 'ARTIFACT_REVISION_MISMATCH' });
  assert.throws(() => resolveDocumentLocation(artifact, word.id), { code: 'UNSEALED_ARTIFACT' });
});

const cacheScope = (partId, changes = {}) => ({ userId: 'user-a', documentId: 'doc-a', revision: 'a'.repeat(64), partId, ...changes });
test('artifact cache is byte bounded with LRU eviction and does not evict for an oversized part', () => {
  const cache = createArtifactPartCache({ maxBytes: 10, maxEntries: 4 });
  cache.set(cacheScope('a'), 'a', 4); cache.set(cacheScope('b'), 'b', 4);
  assert.equal(cache.get(cacheScope('a')), 'a');
  cache.set(cacheScope('c'), 'c', 4);
  assert.equal(cache.get(cacheScope('b')), undefined);
  assert.equal(cache.set(cacheScope('huge'), 'huge', 11), false);
  assert.equal(cache.get(cacheScope('a')), 'a');
  assert.equal(cache.metrics.estimatedBytes, 8);
  assert.equal(cache.metrics.evictions, 1);
});

test('artifact cache isolates user, document and revision, and releases one user only', () => {
  const cache = createArtifactPartCache({ maxBytes: 100, maxEntries: 4 });
  cache.set(cacheScope('a'), 'first', 5);
  for (const change of [{ userId: 'user-b' }, { documentId: 'doc-b' }, { revision: 'b'.repeat(64) }]) {
    assert.equal(cache.get(cacheScope('a', change)), undefined);
  }
  cache.set(cacheScope('a', { userId: 'user-b' }), 'other', 5);
  cache.clearUser('user-a');
  assert.equal(cache.get(cacheScope('a')), undefined);
  assert.equal(cache.get(cacheScope('a', { userId: 'user-b' })), 'other');
  assert.throws(() => cache.set(cacheScope('mutable'), {}, 5), { code: 'MUTABLE_CACHE_VALUE' });
  assert.throws(() => cache.set(cacheScope('nested'), Object.freeze({ child: {} }), 5), { code: 'MUTABLE_CACHE_VALUE' });
  assert.throws(() => cache.set(cacheScope('map'), Object.freeze(new Map()), 5), { code: 'MUTABLE_CACHE_VALUE' });
  cache.clear(); assert.equal(cache.metrics.estimatedBytes, 0);
});

test('cache entry-count bounds and replacement accounting hold for tiny values', () => {
  const cache = createArtifactPartCache({ maxBytes: 100, maxEntries: 2 });
  cache.set(cacheScope('a'), 'a', 2); cache.set(cacheScope('b'), 'b', 2);
  cache.set(cacheScope('a'), 'updated', 7);
  assert.equal(cache.metrics.estimatedBytes, 9);
  cache.set(cacheScope('c'), 'c', 1);
  assert.equal(cache.metrics.entries, 2); assert.equal(cache.metrics.estimatedBytes, 8);
  assert.equal(cache.get(cacheScope('b')), undefined);
});
