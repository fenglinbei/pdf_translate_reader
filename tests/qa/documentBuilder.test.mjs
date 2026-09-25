import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentArtifact, inspectDocumentInputs } from '../../shared/qaDocumentBuilder.mjs';
import { resolveDocumentLocation, getSectionPath } from '../../shared/qaDocumentArtifact.mjs';
import { parseMmdStructure, readBraced } from '../../shared/qaDocumentStructure.mjs';

const hash = 'a'.repeat(64);
const line = (text, lineIndex, y = 100 + lineIndex * 20, x = 100) => ({ text, lineIndex, region: { x, y, width: 600, height: 20 } });
const page = (pageIndex, lines) => ({ pageIndex, lines, pageWidth: 1000, pageHeight: 1000 });
const build = (mmd, pages, options) => buildDocumentArtifact({ pdfSha256: hash, mmd, pages }, options);
const findNode = (artifact, text) => artifact.nodes.find(node => node.text.includes(text));
const locationOf = (artifact, text) => { const node = findNode(artifact, text), offset = node.text.indexOf(text); return resolveDocumentLocation(artifact, node.id, [offset, offset + text.length]); };

test('explicit headings preserve hierarchy and nested braces without guessing years or table cells', () => {
  assert.deepEqual(readBraced('{A {nested} title}', 0), { value: 'A {nested} title', end: 18 });
  const { nodes } = parseMmdStructure(String.raw`\section*{Method {Overview}}

2026. A reference title.

\subsection{Audit}

Normal paragraph.

\begin{table}
\begin{tabular}{ll}
Method & 2024. Complex Claim \\
\end{tabular}
\end{table}`, 1);
  assert.deepEqual(nodes.filter(n => n.kind === 'section').map(n => [n.text, n.level]), [['Method {Overview}', 1], ['Audit', 2]]);
  assert.equal(nodes.at(-1).kind, 'table');
  assert.equal(nodes.at(-1).parentId, nodes.find(n => n.text === 'Audit').id);
});

test('canonical prose reads the MMD word while physical missing-hyphen wrap retains both exact source intervals', async () => {
  const { artifact } = await build('## Human audit\n\nThe observed relation agreement is moderate and calibration remains weak.', [page(0, [
    line('Human audit', 0), line('The observed relation agreement is mod', 1), line('erate and calibration remains weak.', 2),
  ])]);
  const node = findNode(artifact, 'moderate');
  assert.equal(node.text.includes('mod erate'), false);
  assert.deepEqual(getSectionPath(artifact, node.id), ['Human audit']);
  const location = locationOf(artifact, 'moderate');
  assert.equal(location.precision, 'line');
  assert.deepEqual(location.sourceSpans.map(span => [span.lineNumber, span.startOffset, span.endOffset]), [[2, 35, 38], [3, 0, 5]]);
});

test('explicit physical hyphen and NFC normalize with provenance; unrelated spaces never join', async () => {
  const { artifact } = await build('We observed a café with moderate confidence in this experiment.', [page(0, [
    line('We observed a cafe\u0301 with mod-', 0), line('erate confidence in this experiment.', 1),
  ])]);
  assert.equal(locationOf(artifact, 'café').precision, 'line');
  assert.equal(locationOf(artifact, 'moderate').sourceSpans.length, 2);
  const wrong = await build('We observed a modern result with strong evidence.', [page(0, [line('We observed a mode rn result with strong evidence.', 0)])]);
  assert.equal(locationOf(wrong.artifact, 'modern').mappingComplete, false);
});

test('no coordinates or a distant column cannot silently repair a word', async () => {
  for (const lines of [
    [{ text: 'The observed relation agreement is mod', lineIndex: 0 }, { text: 'erate and calibration remains weak.', lineIndex: 1 }],
    [line('The observed relation agreement is mod', 0), line('erate and calibration remains weak.', 1, 120, 700)],
  ]) {
    const { artifact } = await build('The observed relation agreement is moderate and calibration remains weak.', [page(0, lines)]);
    assert.equal(locationOf(artifact, 'moderate').mappingComplete, false);
  }
});

test('page markers disambiguate repeated prose and a trailing marker creates no extra page', async () => {
  const text = 'Identical findings require independent physical attribution.';
  const mmd = `${text}\n\n\\pagebreak\n\n${text}\n\\pagebreak\n`;
  const { artifact, stats } = await build(mmd, [page(0, [line(text, 0)]), page(1, [line(text, 0)])]);
  assert.equal(stats.hasPageHints, true);
  assert.equal(artifact.pageCount, 2);
  assert.notEqual(artifact.nodes[0].id, artifact.nodes[1].id);
  assert.equal(resolveDocumentLocation(artifact, artifact.nodes[0].id).anchor.pageNumber, 1);
  assert.equal(resolveDocumentLocation(artifact, artifact.nodes[1].id).anchor.pageNumber, 2);
  const ambiguous = await build(text, [page(0, [line(text, 0)]), page(1, [line(text, 0)])]);
  assert.equal(locationOf(ambiguous.artifact, text).precision, 'unavailable');
});

test('same-box table aliases are suppressed while equal text at another position remains distinct', async () => {
  const table = String.raw`\begin{tabular}{ll}
Confidence & ECE 0.392; Brier 0.329 \\
\end{tabular}`;
  const whole = { ...line(table, 0), region: { x: 100, y: 100, width: 600, height: 150 } };
  const { artifact, stats } = await build(table, [page(0, [whole,
    { ...line('ECE 0.392; Brier 0.329', 1), region: { x: 200, y: 140, width: 300, height: 20 } },
    line('ECE 0.392; Brier 0.329', 2, 700),
  ])]);
  assert.equal(stats.suppressedAliases, 1);
  const location = resolveDocumentLocation(artifact, artifact.nodes[0].id);
  assert.equal(location.precision, 'block');
  assert.equal(location.lineRegions.length, 1);
  assert.equal(locationOf(artifact, '0.392').precision, 'page'); // Coarse block, not invented cell geometry.
});

test('cancel after checkpoint and resume reproduces the same immutable artifact', async () => {
  const paragraphs = Array.from({ length: 55 }, (_, i) => `Paragraph number ${i} contains its own unique reading evidence.`);
  const input = { pdfSha256: hash, mmd: paragraphs.join('\n\n'), pages: [page(0, paragraphs.map((text, i) => line(text, i, 10 + i * 10)))] };
  const abort = new AbortController(); let saved;
  await assert.rejects(buildDocumentArtifact(input, { signal: abort.signal, onCheckpoint: async value => { saved = structuredClone(value); abort.abort(); } }), { name: 'AbortError' });
  assert.equal(saved.nextNode, 24);
  const resumed = await buildDocumentArtifact(input, { checkpoint: saved });
  const fresh = await buildDocumentArtifact(input);
  assert.deepEqual(resumed.artifact, fresh.artifact);
  assert.equal(resumed.stats.resumedNodes, 24);
  assert.ok(Object.isFrozen(resumed.artifact));
  const changed = await buildDocumentArtifact({ ...input, mmd: input.mmd + '\n\nNew evidence.' }, { checkpoint: saved });
  assert.equal(changed.stats.resumedNodes, 0);
});

test('revision ignores device bookkeeping, pins content and checks malformed checkpoint boundaries', async () => {
  const input = { pdfSha256: hash, mmd: 'Original readable statement.', pages: [page(0, [line('Original readable statement.', 0)])] };
  const first = await buildDocumentArtifact(input);
  const decorated = structuredClone(input); decorated.pages[0].updatedAt = 'other device'; decorated.pages[0].pdfFingerprint = 'device-specific';
  assert.equal((await inspectDocumentInputs(decorated)).revision, first.artifact.revision);
  decorated.pages[0].lines[0].text = 'Different parsed words.';
  assert.notEqual((await inspectDocumentInputs(decorated)).revision, first.artifact.revision);
  const invalid = { version: 'document-preparation-v1', revision: first.artifact.revision, nextNode: 1, mappings: [{ nodeId: 'invented', segments: [] }] };
  await assert.rejects(buildDocumentArtifact(input, { checkpoint: invalid }), { code: 'INVALID_PREPARATION_CHECKPOINT' });
});
