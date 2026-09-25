import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentArtifact } from '../../shared/qaDocumentBuilder.mjs';
import { createPreparationPool, validateCandidateInWorker } from '../../server/qa/documentArtifacts/preparationPool.mjs';
import { assertParserStoragePaths } from '../../server/qa/documentArtifacts/storage.mjs';

const input = { pdfSha256: 'a'.repeat(64), mmd: '# Audit\n\nThis synthetic paragraph supports the reported observation.', pages: [{ pageIndex: 0,
  lines: [{ lineIndex: 0, text: 'This synthetic paragraph supports the reported observation.' }] }] };
test('service-role source reads reject cross-owner paths and namespace traversal even in an owned metadata row', () => {
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', content = `sha256-${'a'.repeat(64)}`;
  const document = { content_sha256: content, storage_path: `${owner}/${content}.pdf` };
  const parsed = { content_sha256: content, mathpix_options_hash: 'mathpix-v3-pdf-options',
    pages_storage_path: `${owner}/${content}/mathpix-v3-pdf-options/pages.json`, full_mmd_storage_path: `${owner}/${content}/mathpix-v3-pdf-options/full.mmd` };
  assert.doesNotThrow(() => assertParserStoragePaths(owner, document, parsed));
  for (const changed of [{ ...parsed, pages_storage_path: 'other-user/private/pages.json' }, { ...parsed, mathpix_options_hash: '../other' }])
    assert.throws(() => assertParserStoragePaths(owner, document, changed), { code: 'INVALID_SOURCE_STORAGE_SCOPE' });
  assert.throws(() => assertParserStoragePaths(owner, { ...document, storage_path: `${owner}/../other/private.pdf` }, parsed), { code: 'INVALID_SOURCE_STORAGE_SCOPE' });
});
test('publication worker verifies derivation against source, not just candidate hashes or shape', async () => {
  const { artifact } = await buildDocumentArtifact(input);
  const accepted = await validateCandidateInWorker(input, JSON.stringify(artifact));
  assert.equal(accepted.result.manifest.revision, artifact.revision);
  const forged = structuredClone(artifact);
  forged.mappings[1].segments = []; // Still structurally valid, same source hashes.
  await assert.rejects(validateCandidateInWorker(input, JSON.stringify(forged)), { code: 'CANDIDATE_SOURCE_MISMATCH' });
  const forgedText = structuredClone(artifact); forgedText.nodes[1].text = 'Fabricated support.'; forgedText.mappings[1].segments = [];
  await assert.rejects(validateCandidateInWorker(input, JSON.stringify(forgedText)), { code: 'CANDIDATE_SOURCE_MISMATCH' });
});
test('bounded background fallback uses the same deterministic builder and can parse source JSON off the HTTP thread', async () => {
  const { pages, ...rest } = input;
  const result = await validateCandidateInWorker({ ...rest, pagesText: JSON.stringify(pages) });
  assert.equal(result.result.manifest.nodes.length, 2);
  assert.ok(result.result.files.some(file => file.id.startsWith('r_')));
  assert.ok(result.result.files.some(file => file.id.startsWith('l_')));
});
test('server preparation queue rejects excess work and serializes accepted tasks', async () => {
  const pool = createPreparationPool({ concurrency: 1, maxQueued: 2 });
  let release, running = 0, peak = 0; const order = [];
  const first = pool.submit(async () => { running++;peak=Math.max(peak,running);order.push(1);await new Promise(resolve=>{release=resolve;});running--;return 1; });
  await Promise.resolve();
  const second = pool.submit(async () => {running++;peak=Math.max(peak,running);order.push(2);running--;return 2;});
  const third = pool.submit(async () => {running++;peak=Math.max(peak,running);order.push(3);running--;return 3;});
  await assert.rejects(pool.submit(async()=>4),{code:'PREPARATION_BUSY'});
  assert.deepEqual(pool.metrics,{active:1,queued:2,concurrency:1,maxQueued:2});
  release();assert.deepEqual(await Promise.all([first,second,third]),[1,2,3]);
  assert.deepEqual(order,[1,2,3]);assert.equal(peak,1);
});
test('aborted worker validation terminates without accepting a candidate', async () => {
  const controller = new AbortController();
  const work = validateCandidateInWorker(input, undefined, { signal: controller.signal });
  controller.abort();await assert.rejects(work,{name:'AbortError'});
});
