import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentArtifact } from '../../shared/qaDocumentBuilder.mjs';
import { packDocumentArtifact, sealDocumentManifest } from '../../shared/qaDocumentParts.mjs';
import { createArtifactLoader } from '../../server/qa/documentArtifacts/loader.mjs';

async function prepare(text = 'The observed relation agreement is moderate and calibration remains weak.') {
  const result = await buildDocumentArtifact({ pdfSha256: 'a'.repeat(64), mmd: `# Audit\n\n${text}`, pages: [{ pageIndex: 0, pageWidth: 1000, pageHeight: 1000,
    lines: text.includes('moderate') ? [{ lineIndex: 0, text: 'The observed relation agreement is mod', region: { x: 100, y: 100, width: 600, height: 20 } },
      { lineIndex: 1, text: 'erate and calibration remains weak.', region: { x: 100, y: 120, width: 600, height: 20 } }] : [{ lineIndex: 0, text }] }] });
  const packed = await packDocumentArtifact(result.artifact);
  return { ...packed, node: packed.manifest.nodes.find(n => n.kind === 'paragraph') };
}
function setup(packed, settings = {}) {
  const loads = [], access = [];
  let revoked = false;
  const files = new Map(packed.files.map(file => [file.id, file.text]));
  const scope = { userId: 'alice', documentId: 'paper', revision: packed.manifest.revision, manifestSha256: packed.manifestSha256 };
  const loader = createArtifactLoader({ ...settings, loadText: async scope => { loads.push(scope); return scope.partId === 'manifest' ? packed.manifestText : files.get(scope.partId); },
    authorize: async scope => { access.push(scope); if (revoked) throw new Error('access revoked'); } });
  return { loader, loads, access, files, scope, revoke() { revoked = true; } };
}
test('reading loads only body parts; an actually used citation loads only its location part', async () => {
  const packed = await prepare(), testbed = setup(packed), reader = await testbed.loader.open(testbed.scope);
  const receipt = await reader.read(packed.node.id);
  assert.equal(receipt.text.includes('moderate'), true);
  assert.deepEqual(receipt.sectionPath, ['Audit']);
  assert.equal(testbed.loads.some(load => load.partId.startsWith('l_')), false);
  const location = await reader.locate(receipt);
  assert.equal(location.precision, 'line');
  assert.equal(location.lineRegions.length, 2);
  assert.equal(testbed.loads.filter(load => load.partId.startsWith('l_')).length, 1);
  await assert.rejects(reader.locate(structuredClone(receipt)), { code: 'READ_SCOPE_MISMATCH' });
});
test('neighboring paragraphs share a bounded transfer while retaining separate read coverage', async () => {
  const paragraphs = Array.from({ length: 90 }, (_, i) => `Paragraph number ${i} has its own independently readable evidence.`);
  const { artifact } = await buildDocumentArtifact({ pdfSha256: 'a'.repeat(64), mmd: paragraphs.join('\n\n'),
    pages: [{ pageIndex: 0, lines: paragraphs.map((text, lineIndex) => ({ text, lineIndex })) }] });
  const packed = await packDocumentArtifact(artifact), testbed = setup(packed), reader = await testbed.loader.open(testbed.scope);
  const first = await reader.read(packed.manifest.nodes[0].id), count = testbed.loads.length;
  const second = await reader.read(packed.manifest.nodes[1].id);
  assert.equal(testbed.loads.length, count);
  assert.notEqual(first.nodeId, second.nodeId);
  assert.equal(first.text, paragraphs[0]); assert.equal(second.text, paragraphs[1]);
  assert.equal(packed.files.filter(file => file.id.startsWith('r_')).length, 2);
  const checks = testbed.access.length;
  const batch = await reader.readBatch(packed.manifest.nodes.slice(2,12).map(node => ({ nodeId: node.id, maxChars: 1000 })));
  assert.equal(batch.length, 10);
  assert.equal(testbed.access.length - checks, 2); // Once before/after the operation, not once per paragraph.
});
test('warm content avoids downloading while revoked access is checked again', async () => {
  const packed = await prepare(), testbed = setup(packed);
  const first = await testbed.loader.open(testbed.scope); await first.read(packed.node.id);
  const count = testbed.loads.length, accesses = testbed.access.length;
  const second = await testbed.loader.open(testbed.scope); await second.read(packed.node.id);
  assert.equal(testbed.loads.length, count);
  assert.ok(testbed.access.length > accesses);
  testbed.revoke();
  await assert.rejects(second.read(packed.node.id), /access revoked/);
  await assert.rejects(testbed.loader.open(testbed.scope), /access revoked/);
});
test('large logical nodes have bounded transport fragments without changing their reading identity', async () => {
  const text = 'Unique prefix ' + 'abcd '.repeat(2397) + '😀' + ' suffix '.repeat(2000);
  const packed = await prepare(text), testbed = setup(packed), reader = await testbed.loader.open(testbed.scope);
  assert.ok(packed.node.readingParts.length >= 3);
  assert.equal(packed.manifest.nodes.filter(n => n.kind === 'paragraph').length, 1);
  let offset = 0, reconstructed = '';
  while (offset < packed.node.textLength) {
    const receipt = await reader.read(packed.node.id, { start: offset, maxChars: 12000 });
    reconstructed += receipt.text; offset = receipt.range[1];
    assert.equal(receipt.nodeId, packed.node.id);
  }
  assert.equal(reconstructed, text.trim().replace(/\s+/g, ' '));
  const emoji = reconstructed.indexOf('😀');
  await assert.rejects(reader.read(packed.node.id, { start: emoji + 1, maxChars: 10 }), { code: 'INVALID_TEXT_RANGE' });
});
test('tampered parts, cached manifest hash changes and missing coverage fail closed', async () => {
  const packed = await prepare(), testbed = setup(packed), reader = await testbed.loader.open(testbed.scope);
  testbed.files.set(packed.node.readingParts[0], 'tampered');
  await assert.rejects(reader.read(packed.node.id), { code: 'DOCUMENT_PART_MISMATCH' });
  await assert.rejects(testbed.loader.open({ ...testbed.scope, manifestSha256: 'b'.repeat(64) }), { code: 'DOCUMENT_PART_MISMATCH' });
  const changed = structuredClone(packed.manifest); changed.nodes.find(n => n.id === packed.node.id).readingParts = [];
  await assert.rejects(sealDocumentManifest(changed), { code: 'INVALID_DOCUMENT_MANIFEST' });
});
test('single-flight coalesces downloads only within the same user and bounded cache scope', async () => {
  const packed = await prepare(), testbed = setup(packed);
  const [first, second] = await Promise.all([testbed.loader.open(testbed.scope), testbed.loader.open(testbed.scope)]);
  await Promise.all([first.read(packed.node.id), second.read(packed.node.id)]);
  assert.equal(testbed.loads.filter(load => load.partId === 'manifest').length, 1);
  assert.equal(testbed.loads.filter(load => load.partId === packed.node.readingParts[0]).length, 1);
  const other = await testbed.loader.open({ ...testbed.scope, userId: 'bob' }); await other.read(packed.node.id);
  assert.equal(testbed.loads.filter(load => load.partId === 'manifest').length, 2);
  testbed.loader.clearUser('alice');
  await testbed.loader.open(testbed.scope);
  assert.equal(testbed.loads.filter(load => load.partId === 'manifest').length, 3);
  assert.equal(testbed.loader.metrics.pendingLoads, 0);
});
