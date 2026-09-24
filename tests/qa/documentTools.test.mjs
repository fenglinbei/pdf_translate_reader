import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDocumentView, createEvidenceStore, normalizeWithMap } from '../../server/qa/documents/view.mjs';
import { resolveCitationSelections, verifyDocumentAnswer } from '../../server/qa/documents/citations.mjs';
import { createDocumentTools, validateDocumentTool } from '../../server/qa/documents/tools.mjs';

const line = (text, y, coords = true) => ({ text, ...(coords ? { region: { x: 10, y, width: 80, height: 5 } } : {}) });
function setup(overrides = {}) {
  const view = createDocumentView({ documentId: 'test-doc', documentVersion: 'test-version', sourceRecordId: 'test-source', title: 'Synthetic methods',
    pages: [{ pageIndex: 0, width: 100, height: 100, lines: [line('# 1 Method', 1), '', line('Gate weights fuse different branches.', 15), line('Repeat this sentence.', 25), line('First context.', 35)] },
      { pageIndex: 1, width: 100, height: 100, lines: [line('Second context. Repeat this sentence.', 5), line('Cafe\u0301 uses α weights.', 15), line('# References', 35)] },
      { pageIndex: 2, width: 100, height: 100, lines: [line('# Appendix', 1), line('The appendix contains extra implementation details.', 15)] },
      { pageIndex: 3, lines: [] }], ...overrides });
  const store = createEvidenceStore(view);
  const source = { view, assertCurrent: async () => {} };
  return { view, store, source, tools: createDocumentTools({ source, store }) };
}
const select = (id, quote, extra = {}) => ({ kind: 'quote', sourceEvidenceIds: [id], quote, ...extra });

test('document view keeps empty lines/pages and references plus later appendix', () => {
  const { view } = setup();
  assert.equal(view.pageCount, 4);
  assert.equal(view.pages[3].missingText, true);
  assert.equal(view.lines.find((l) => l.text.startsWith('Gate')).lineNumber, 3);
  assert(view.text.includes('appendix contains'));
  assert(view.sections.some((s) => s.title === 'References'));
});

test('NFC and whitespace normalization maps back to original UTF-16 source', () => {
  const value = 'Cafe\u0301  \nuses 😀';
  const result = normalizeWithMap(value);
  assert.equal(result.text, 'Café uses 😀');
  const index = result.text.indexOf('é');
  assert.equal(value.slice(result.starts[index], result.ends[index]), 'e\u0301');
  assert.equal(result.text.length, result.starts.length);
});

test('a model selects text only; harness locates chapter, physical page and matching line', async () => {
  const { tools, store } = setup();
  const read = await tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 2 });
  const parent = store.byId.get(read.evidence[0].evidenceId);
  const result = await tools.execute('finish_reading', { mode: 'grounded', citationSelections: [select(parent.evidenceId, 'Gate weights fuse different branches.')], answerOutline: 'Explain fusion.' });
  assert.equal(parent.text.includes('Second context'), true);
  const citation = result.citations[0];
  assert.notEqual(citation.evidenceId, parent.evidenceId);
  assert.equal(citation.pageStart, 1);
  assert.deepEqual(citation.lineRegions.map((r) => r.lineNumber), [3]);
  assert.deepEqual(citation.sectionPath, ['1 Method']);
  assert.equal(citation.locationPrecision, 'line');
  assert.equal(citation.sourceSpans[0].startOffset, 0);
});

test('duplicate quotes require read context; failure does not assign any identifiers', async () => {
  const { tools, store } = setup();
  const read = await tools.execute('read_document', { mode: 'full' });
  const id = read.evidence[0].evidenceId, before = store.evidence.length;
  assert.throws(() => resolveCitationSelections(store, [select(id, 'Gate weights'), select(id, 'Repeat this sentence.')]), { code: 'AMBIGUOUS_QUOTE' });
  assert.equal(store.evidence.length, before);
  const result = resolveCitationSelections(store, [select(id, 'Repeat this sentence.', { contextBefore: 'Second context.' })]);
  assert.equal(result.citations[0].pageStart, 2);
  assert.equal(result.citations[0].lineRegions[0].lineNumber, 1);
});

test('same text at the same source location via multiple reads is not ambiguous', () => {
  const { store, view } = setup();
  const whole = store.add(0, view.text.length);
  const page = store.add(0, view.pages[0].end);
  const result = resolveCitationSelections(store, [{ kind: 'quote', sourceEvidenceIds: [whole.evidenceId, page.evidenceId], quote: 'Gate weights' }]);
  assert.equal(result.citations.length, 1);
});

test('matching cannot borrow unseen source text or silently correct rewritten quotes', async () => {
  const { tools, store } = setup();
  const read = await tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 1 });
  const id = read.evidence[0].evidenceId;
  assert.throws(() => resolveCitationSelections(store, [select(id, 'Second context.')]), { code: 'QUOTE_NOT_FOUND' });
  assert.throws(() => resolveCitationSelections(store, [select(id, 'GATE weights')]), { code: 'QUOTE_NOT_FOUND' });
});

test('formatted formulas accompany read text without changing quote identity or line mapping', async () => {
  const text = 'alpha_i = exp(z_i) / sum_j exp(z_j).';
  const latex = String.raw`\[\alpha_i=\frac{\exp(z_i)}{\sum_j\exp(z_j)}\]`;
  const { tools, view, store } = setup({ pages: [{ width: 100, height: 100, lines: [{ ...line(text, 10), latex }] }] });
  const read = await tools.execute('read_document', { mode: 'full' });
  assert.deepEqual(read.evidence[0].latexLines, [{ text, latex }]);
  assert.equal(read.evidence[0].text, text + '\n');
  assert.equal(tools.metrics.returnedChars, view.text.length + text.length + latex.length);
  const result = resolveCitationSelections(store, [select(read.evidence[0].evidenceId, text)]);
  assert.deepEqual(result.citations[0].lineRegions.map(r => r.lineNumber), [1]);
  assert.throws(() => resolveCitationSelections(store, [select(read.evidence[0].evidenceId, latex)]), { code: 'QUOTE_NOT_FOUND' });
});

test('partial search previews do not reveal unread formula text through a LaTeX copy', async () => {
  const text = 'Formula ' + 'x'.repeat(600) + ' hidden suffix.';
  const { tools } = setup({ pages: [{ lines: [{ text, latex: 'private formula suffix' }] }] });
  const search = await tools.execute('search_document_text', { queries: ['Formula'], matchMode: 'literal' });
  assert.equal(search.evidence[0].text.length, 400);
  assert.equal(search.evidence[0].latexLines, undefined);
  assert.equal(search.evidence[0].latexOmitted, true);
});

test('formula supplements respect read/full/run budgets and reserve all search previews', async () => {
  const { source, store, view } = setup({ pages: [{ lines: [{ text: 'Formula A', latex: 'a'.repeat(80) },
    { text: 'Formula B', latex: 'b'.repeat(80) }] }] });
  for (const limits of [{ maxReadChars: view.text.length }, { maxFullChars: view.text.length }, { maxTotalChars: view.text.length }]) {
    const tools = createDocumentTools({ source, store, ...limits });
    const read = await tools.execute('read_document', 'maxReadChars' in limits ? { mode: 'pages', pageStart: 1, pageEnd: 1 } : { mode: 'full' });
    assert.equal(read.evidence[0].latexLines, undefined);
    assert.equal(read.evidence[0].latexOmitted, true);
    assert.equal(tools.metrics.returnedChars, view.text.length);
  }
  const canonicalChars = view.text.length + 'Formula B\n'.length;
  const tools = createDocumentTools({ source, store, maxTotalChars: canonicalChars });
  const search = await tools.execute('search_document_text', { queries: ['Formula'], matchMode: 'literal' });
  assert.equal(search.evidence.length, 2);
  assert(search.evidence.every(e => e.latexOmitted && !e.latexLines));
  assert.equal(tools.metrics.returnedChars, canonicalChars);
});

test('cross-page quote anchors at first page even when later page has more lines', async () => {
  const { tools } = setup();
  const read = await tools.execute('read_document', { mode: 'full' });
  const result = await tools.execute('finish_reading', { mode: 'grounded', citationSelections: [select(read.evidence[0].evidenceId,
    'First context. Second context. Repeat this sentence. Café uses α weights.')], answerOutline: '' });
  const c = result.citations[0];
  assert.equal(c.pageStart, 1); assert.equal(c.pageEnd, 2);
  assert.deepEqual(c.anchor, { pageNumber: 1, lineNumber: 5 });
  assert.deepEqual(c.lineRegions.map((r) => r.pageNumber), [1, 2, 2]);
});

test('missing coordinates degrades location without changing evidence or fabricating rectangles', () => {
  const { store, view } = setup({ pages: [{ pageIndex: 0, width: 100, height: 100, lines: [line('First sentence.', 1), line('Second sentence.', 10, false)] }] });
  const parent = store.add(0, view.text.length);
  const result = resolveCitationSelections(store, [select(parent.evidenceId, 'First sentence. Second sentence.')]);
  assert.equal(result.citations[0].locationPrecision, 'partial-line');
  assert.equal(result.citations[0].lineRegions.length, 1);
  assert.equal(resolveCitationSelections(store, [select(parent.evidenceId, 'Second sentence.')]).citations[0].locationPrecision, 'page');
});

test('source selection is a chapter only when actual read coverage matches its boundaries', async () => {
  const { tools } = setup();
  const outline = await tools.execute('get_document_outline', {});
  const read = await tools.execute('read_document', { mode: 'section', sectionId: outline.sections[0].sectionId });
  const finish = await tools.execute('finish_reading', { mode: 'grounded', citationSelections: [{ kind: 'source', sourceEvidenceIds: [read.evidence[0].evidenceId] }], answerOutline: '' });
  assert.equal(finish.citations[0].kind, 'section');
  const page = await tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 1 });
  const partial = await tools.execute('finish_reading', { mode: 'grounded', citationSelections: [{ kind: 'source', sourceEvidenceIds: [page.evidence[0].evidenceId] }], answerOutline: '' });
  assert.equal(partial.citations[0].kind, 'range');
});

test('tool schemas reject coordinates, extra fields and coerced numbers', () => {
  for (const args of [{ mode: 'pages', pageStart: '1', pageEnd: 2 }, { mode: 'full', userId: 'other-user' }]) {
    assert.throws(() => validateDocumentTool('read_document', args), { code: 'INVALID_TOOL_ARGUMENTS' });
  }
  assert.throws(() => validateDocumentTool('finish_reading', { mode: 'grounded', citationSelections: [{ ...select('C1', 'text'), pageNumber: 4 }], answerOutline: '' }), { code: 'INVALID_TOOL_ARGUMENTS' });
  assert.throws(() => validateDocumentTool('__proto__', {}), { code: 'UNKNOWN_TOOL' });
});

test('memoization preserves source IDs and still rechecks permission/version', async () => {
  const { source, store } = setup();
  let checks = 0;
  source.assertCurrent = async () => { checks++; if (checks === 3) throw new Error('source changed'); };
  const tools = createDocumentTools({ source, store });
  const a = await tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 1 });
  const b = await tools.execute('read_document', { pageEnd: 1, pageStart: 1, mode: 'pages' });
  assert.equal(b.cacheHit, true); assert.deepEqual(a.evidence, b.evidence);
  await assert.rejects(tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 1 }), /source changed/);
});

test('bounded reading gives a source-bound continuation and full mode never truncates', async () => {
  const { source, store } = setup();
  const tools = createDocumentTools({ source, store, maxReadChars: 40, maxFullChars: 80 });
  await assert.rejects(tools.execute('read_document', { mode: 'full' }), { code: 'FULL_TEXT_TOO_LARGE' });
  const first = await tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 2 });
  assert.equal(first.hasMore, true);
  const next = await tools.execute('read_document', { pageEnd: 2, pageStart: 1, mode: 'pages', cursor: first.cursor });
  assert.equal(next.evidence[0].text.startsWith(first.evidence[0].text), false);
  await assert.rejects(tools.execute('read_document', { mode: 'pages', pageStart: 1, pageEnd: 1, cursor: first.cursor }), { code: 'INVALID_CURSOR' });
});

test('literal search reads appendix text without any semantic index', async () => {
  const { tools } = setup();
  const result = await tools.execute('search_document_text', { queries: ['EXTRA implementation'], matchMode: 'literal' });
  assert(result.evidence.some((e) => e.text.includes('appendix')));
  assert.equal(result.scannedEntireScope, true);
});

test('final verifier rejects unselected parent citations and fabricated IDs', async () => {
  const { tools } = setup();
  const read = await tools.execute('read_document', { mode: 'full' });
  const prepared = await tools.execute('finish_reading', { mode: 'grounded', citationSelections: [select(read.evidence[0].evidenceId, 'Gate weights')], answerOutline: '' });
  assert.equal(verifyDocumentAnswer(`Answer [${prepared.allowedCitationIds[0]}]`, prepared).valid, true);
  assert.equal(verifyDocumentAnswer('Answer [C1] [C999]', prepared).valid, false);
  assert.equal(verifyDocumentAnswer('No citations', prepared).valid, false);
});

test('overlapping literal occurrences are ambiguous until the model adds read context', () => {
  const { store, view } = setup({ pages: [{ lines: ['aaaa'] }] });
  const read = store.add(0, view.text.length);
  assert.throws(() => resolveCitationSelections(store, [select(read.evidenceId, 'aaa')]), { code: 'AMBIGUOUS_QUOTE' });
});

test('search previews include late matches in long lines and cursors make forward progress', async () => {
  const { tools } = setup({ pages: [{ lines: Array.from({ length: 6 }, (_, i) => `${'x'.repeat(600)} needle-${i} ${'z'.repeat(450)}`) }] });
  const args = { queries: ['needle'], matchMode: 'literal', limit: 2 };
  let cursor; const evidence = [];
  for (let i = 0; i < 5; i++) {
    const result = await tools.execute('search_document_text', { ...args, ...(cursor ? { cursor } : {}) });
    evidence.push(...result.evidence);
    if (!result.hasMore) break;
    cursor = result.cursor;
  }
  assert.equal(evidence.length, 6);
  for (let i = 0; i < 6; i++) assert(evidence[i].text.includes(`needle-${i}`));
});
