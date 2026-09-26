// Offline design/fixture consistency guard. Does not run future M1-M7 cases.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const root = new URL('../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
export const M0_BUDGETS = Object.freeze({
  questionUtf16: 2000, attachments: 4, selectionPerAttachmentUtf16: 4000,
  selectionTotalUtf16: 12000, contextTotalUtf16: 4000,
  cardPreviewUtf16: 300, queryPageItems: 30, readReturnedUtf16: 14000,
  runReturnedUtf16: 96000, scanRecords: 2000, scanUtf16: 1000000,
});
export function loadM0Inputs() {
  return { schema: json('docs/contracts/qa-workspace-m0.schema.json'),
    examples: json('docs/contracts/qa-workspace-m0.examples.json'),
    fixture: json('docs/fixtures/qa-workspace-m0-cases.json') };
}
export function checkM0Manifest(manifest = json('docs/contracts/qa-workspace-m0.freeze.json')) {
  assert.equal(manifest.freezeVersion, 'qa-workspace-m0-freeze-v1', 'unsupported freeze manifest version');
  assert.equal(manifest.status, 'frozen_design', 'manifest must record frozen design status');
  assert.match(manifest.businessRuntimeBaseSha, /^[a-f0-9]{40}$/, 'business runtime base SHA required');
  assert.deepEqual(manifest.protocols, { tools: 'qa-workspace-access-v1', inputAttachments: 'qa-input-attachments-v1', draft: 'qa-conversation-draft-v1' }, 'frozen protocol versions differ');
  assert.deepEqual(manifest.readOnlyTools.slice().sort(), ['workspace_overview','workspace_query','workspace_read','workspace_count','workspace_related'].sort(), 'read-only tool set differs');
  assert.deepEqual(manifest.sources.slice().sort(), ['document_artifact','workspace_record','query_snapshot','user_selection'].sort(), 'source kind set differs');
  assert.match(manifest.budgets.units.chars, /^UTF-16 code units/, 'manifest character unit must be UTF-16');
  assert.equal(manifest.budgets.units.body, 'UTF-8 bytes', 'manifest byte unit must be UTF-8');
  const { futureInput: input, futureWorkspace: workspace, existingRuntimeDefaults: runtime } = manifest.budgets;
  const mappedBudgets = {
    questionUtf16: input.questionUtf16, attachments: input.attachments,
    selectionPerAttachmentUtf16: input.selectionPerAttachmentUtf16,
    selectionTotalUtf16: input.selectionTotalUtf16, contextTotalUtf16: input.contextTotalUtf16,
    cardPreviewUtf16: workspace.cardPreviewUtf16, queryPageItems: workspace.queryMaxItems,
    readReturnedUtf16: runtime.readReturnedUtf16, runReturnedUtf16: runtime.runReturnedUtf16,
    scanRecords: workspace.scanRecordsPerRun, scanUtf16: runtime.scanUtf16PerRun,
  };
  assert.deepEqual(mappedBudgets, M0_BUDGETS, 'manifest budget mismatch with M0_BUDGETS');
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, 'manifest artifacts must be nonempty');
  const repositoryRoot = realpathSync(root);
  const paths = new Set();
  for (const artifact of manifest.artifacts) {
    const path = artifact.path;
    assert(typeof path === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)
      && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..'), `unsafe artifact path: ${path}`);
    assert(!paths.has(path), `duplicate artifact path: ${path}`); paths.add(path);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/, `invalid sha256: ${path}`);
    const resolved = resolve(repositoryRoot, path);
    assert(existsSync(resolved), `missing manifest artifact: ${path}`);
    const actualPath = realpathSync(resolved);
    const relativePath = relative(repositoryRoot, actualPath);
    assert(relativePath && !isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith('../'), `unsafe artifact path outside repository: ${path}`);
    assert(statSync(actualPath).isFile(), `manifest artifact is not a file: ${path}`);
    const actualHash = createHash('sha256').update(readFileSync(actualPath)).digest('hex');
    assert.equal(actualHash, artifact.sha256, `hash mismatch: ${path}`);
  }
  for (const required of ['docs/contracts/qa-workspace-m0.schema.json', 'docs/contracts/qa-workspace-m0.examples.json', 'docs/fixtures/qa-workspace-m0-cases.json'])
    assert(paths.has(required), `required frozen artifact missing: ${required}`);
  return { status: 'pass', freezeVersion: manifest.freezeVersion, artifactsVerified: paths.size,
    budgetMappingsVerified: Object.keys(mappedBudgets).length, hashAlgorithm: 'sha256',
    scope: 'content integrity and frozen design metadata; not runtime acceptance' };
}
export function measureDraftBudget({ question = '', inputAttachments = [] }) {
  assert.equal(typeof question, 'string', 'question must be text');
  assert(Array.isArray(inputAttachments), 'attachments must be an array');
  const selections = inputAttachments.map(attachment => (attachment.selectionSegments ?? []).reduce((sum, segment) =>
    sum + Math.max((segment.rawText ?? '').length, (segment.normalizedText ?? '').length), 0));
  const contextUtf16 = inputAttachments.reduce((sum, attachment) => sum + (attachment.contextSegments ?? []).reduce((total, segment) => total + segment.text.length, 0), 0);
  const selectionUtf16 = selections.reduce((sum, value) => sum + value, 0);
  const exceeded = [];
  if (question.length > M0_BUDGETS.questionUtf16) exceeded.push('questionUtf16');
  if (inputAttachments.length > M0_BUDGETS.attachments) exceeded.push('attachments');
  if (selections.some(value => value > M0_BUDGETS.selectionPerAttachmentUtf16)) exceeded.push('selectionPerAttachmentUtf16');
  if (selectionUtf16 > M0_BUDGETS.selectionTotalUtf16) exceeded.push('selectionTotalUtf16');
  if (contextUtf16 > M0_BUDGETS.contextTotalUtf16) exceeded.push('contextTotalUtf16');
  return { questionUtf16: question.length, attachmentCount: inputAttachments.length,
    selectionPerAttachmentUtf16: selections, selectionUtf16, contextUtf16, exceeded };
}
export function checkM0({ schema, examples, fixture } = loadM0Inputs()) {
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  assert(examples.valid.length > 0 && examples.invalid.length > 0, 'both example classes must be populated');
  let budgetSamples = 0;
  for (const kind of ['valid', 'invalid']) {
    for (const [index, sample] of examples[kind].entries()) {
      assert.equal(validate(sample), kind === 'valid', `${kind}[${index}] schema expectation differs: ${JSON.stringify(validate.errors)}`);
      if (kind === 'valid' && (sample.schemaVersion === 'qa-input-attachments-v1' || sample.schemaVersion === 'qa-conversation-draft-v1')) {
        const measured = measureDraftBudget(sample.schemaVersion === 'qa-input-attachments-v1' ? { inputAttachments: [sample] } : sample);
        assert.deepEqual(measured.exceeded, [], `${kind}[${index}] exceeds aggregate UTF-16 budget`); budgetSamples++;
      }
    }
  }
  const defs = schema.$defs;
  const sourceKinds = ['document_artifact', 'workspace_record', 'query_snapshot', 'user_selection'];
  assert.deepEqual([...defs.sourceRecord.properties.sourceKind.enum].sort(), sourceKinds.slice().sort(), 'frozen source kind set changed');
  assert.deepEqual(defs.sourceRecord.properties.authority.enum.slice().sort(), ['server_verified_document', 'account_record', 'client_owned_record', 'user_supplied'].sort(), 'frozen source authority set changed');
  const budgetGuards = [
    [defs.draft.properties.question.maxLength, M0_BUDGETS.questionUtf16],
    [defs.draft.properties.inputAttachments.maxItems, M0_BUDGETS.attachments],
    [defs.selectionSegment.properties.normalizedText.maxLength, M0_BUDGETS.selectionPerAttachmentUtf16],
    [defs.contextSegment.properties.text.maxLength, M0_BUDGETS.contextTotalUtf16],
    [defs.card.properties.preview.maxLength, M0_BUDGETS.cardPreviewUtf16],
    [defs.pageData.properties.items.maxItems, M0_BUDGETS.queryPageItems],
    [defs.readData.properties.content.maxLength, M0_BUDGETS.readReturnedUtf16],
    [defs.toolResult.oneOf[0].properties.usage.properties.returnedChars.maximum, M0_BUDGETS.runReturnedUtf16],
    [defs.toolResult.oneOf[0].properties.usage.properties.scannedRecords.maximum, M0_BUDGETS.scanRecords],
    [defs.toolResult.oneOf[0].properties.usage.properties.scannedChars.maximum, M0_BUDGETS.scanUtf16],
  ];
  for (const [actual, expected] of budgetGuards) assert.equal(actual, expected, 'frozen schema budget changed');
  // Numeric schema maxLength parity is NOT unit parity: Ajv counts code points.
  assert.equal('😀中'.length, 3); assert.equal([... '😀中'].length, 2); assert.equal(Buffer.byteLength('😀中'), 7);
  const unicodeDraft = structuredClone(examples.valid.find(sample => sample.schemaVersion === 'qa-conversation-draft-v1'));
  assert(unicodeDraft, 'draft example required'); unicodeDraft.question = '😀'.repeat(1000) + 'a';
  assert.equal(validate(unicodeDraft), true, 'code-point length demonstration must pass shape schema');
  assert.deepEqual(measureDraftBudget(unicodeDraft).exceeded, ['questionUtf16'], 'UTF-16 budget must separately reject 2001 units');

  let fixtureAssertions = 0;
  const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); fixtureAssertions++; };
  const truth = (actual, label) => { assert(actual, label); fixtureAssertions++; };
  equal(fixture.syntheticOnly, true, 'only synthetic fixtures permitted');
  equal(fixture.users.slice().sort(), ['user-a', 'user-b'], 'fixed dual-user fixture');
  equal(fixture.cases.length, 38, 'expected 38 future acceptance cases');
  equal(new Set(fixture.cases.map(item => item.id)).size, 38, 'case IDs must be unique');
  equal(fixture.cases.map(item => item.id).sort(), Array.from({ length: 38 }, (_, i) => `M0-${String(i + 1).padStart(2, '0')}`), 'case IDs must retain M0-01 through M0-38');
  for (const item of fixture.cases) {
    equal(item.executionStatus, 'not_executed', `${item.id}: fixture validation is not integration execution`);
    truth(item.expected && typeof item.expected === 'object' && Object.keys(item.expected).length, `${item.id}: expected oracle required`);
    truth(['planned','partial','existing_regression'].includes(item.currentSupport), `${item.id}: unknown currentSupport`);
    if (item.expected.sourceKind) truth(sourceKinds.includes(item.expected.sourceKind), `${item.id}: unknown source kind`);
    for (const path of item.existingTestReferences) truth(existsSync(new URL(path, root)), `${item.id}: missing existing test reference ${path}`);
  }
  const data = fixture.datasets;
  const byId = new Map();
  for (const [kind, rows] of Object.entries(data)) for (const row of rows) {
    truth(!byId.has(row.id), `duplicate dataset ID ${row.id}`); byId.set(row.id, row);
    if (row.owner !== undefined && row.owner !== null) truth(fixture.users.includes(row.owner), `${kind}/${row.id}: unknown owner`);
  }
  const get = id => { const row = byId.get(id); truth(row, `missing dataset ID ${id}`); return row; };
  const cases = new Map(fixture.cases.map(item => [item.id, item]));
  const expected = id => cases.get(id).expected;
  const activeDocs = data.documents.filter(item => item.owner === 'user-a' && item.state === 'active');
  const liveDocs = data.documents.filter(item => item.owner === 'user-a' && item.state !== 'deleted');
  equal(activeDocs.length, expected('M0-02').totalMatched, 'active document count matches case oracle');
  equal(Math.min(activeDocs.length, cases.get('M0-02').setup.pageSize), expected('M0-02').firstPageCount, 'first page count');
  equal(activeDocs.length > cases.get('M0-02').setup.pageSize, expected('M0-02').hasMore, 'real hasMore');
  equal({ active: activeDocs.length, archived: liveDocs.filter(item => item.state === 'archived').length, allNonDeleted: liveDocs.length,
    deletedExcluded: data.documents.filter(item => item.owner === 'user-a' && item.state === 'deleted').length }, expected('M0-04'), 'archive/delete count oracle');
  const rootCollection = cases.get('M0-05').setup.collection;
  const collectionIds = new Set([rootCollection]);
  for (let size = -1; size !== collectionIds.size;) { size = collectionIds.size; for (const item of data.collections) if (collectionIds.has(item.parent)) collectionIds.add(item.id); }
  const direct = liveDocs.filter(item => item.collections.includes(rootCollection));
  const descendant = liveDocs.filter(item => item.collections.some(id => collectionIds.has(id)));
  equal(direct.length, expected('M0-05').directDistinctDocuments, 'direct collection count');
  equal(descendant.length, expected('M0-05').withDescendantsDistinctDocuments, 'descendant distinct count');
  const tags = cases.get('M0-06').setup.tags;
  equal(liveDocs.filter(item => item.tags.some(tag => tags.includes(tag))).length, expected('M0-06').ANY, 'tag ANY oracle');
  equal(liveDocs.filter(item => tags.every(tag => item.tags.includes(tag))).length, expected('M0-06').ALL, 'tag ALL oracle');
  for (const doc of data.documents) for (const collectionId of doc.collections) equal(get(collectionId).owner, doc.owner, 'collection membership owner');
  for (const collection of data.collections) if (collection.parent) equal(get(collection.parent).owner, collection.owner, 'collection parent owner');
  for (const row of [...data.notes, ...data.terms]) equal(get(row.document).owner, row.owner, 'record/document owner');
  for (const row of data.messages) equal(get(row.thread).owner, row.owner, 'message/thread owner');
  for (const row of data.threads) if (row.group) equal(get(row.group).owner, row.owner, 'thread/group owner');
  const activeThreads = data.threads.filter(item => item.owner === 'user-a' && item.state === 'active');
  equal(activeThreads.length, expected('M0-18').activeThreads, 'thread count');
  equal(new Set([...activeThreads.slice(0,30), ...activeThreads.slice(30,60)].map(item => item.id)).size, expected('M0-18').uniqueAcrossTwoPages, '31-thread pagination oracle');
  equal(get('thread-a01').titleOrigin, 'manual', 'manual title fixture'); equal(get('thread-a01').titleRevision, 2, 'manual revision before race');
  equal(get('thread-a02').titleOrigin, 'legacy', 'legacy title fixture');
  equal(get('term-a01').translation, expected('M0-10').confirmedTerm, 'confirmed term');
  equal(get('term-a01').status, 'confirmed', 'confirmed term provenance'); equal(get('term-a02').status, 'suggested', 'suggested term provenance');
  equal(get('note-a01').kind, 'personal_note', 'personal note must not become document fact');
  equal(get('message-prior-model').role, 'assistant', 'history answer is model output');
  const localKinds = ['pdf','cached_page_text','parsed_mathpix_pages','selection_translation_cache','free_translation_history','free_translation_draft','unsynced_annotation','unsynced_term','conversation_draft','current_reader_environment'];
  equal([...new Set(data.localResources.map(item => item.kind))].sort(), localKinds.sort(), 'full local-resource coverage');
  for (const row of data.localResources) {
    equal(typeof row.available, 'boolean', `${row.id}: explicit availability`);
    if (row.ownership === 'legacy_unowned') equal(row.owner, null, `${row.id}: unclaimed record cannot have assumed owner`);
    else truth(fixture.users.includes(row.owner), `${row.id}: owned local record requires known owner`);
    if (row.cloudDocument) equal(get(row.cloudDocument).owner, row.owner, 'cloud relation owner');
  }
  const localOnly = data.localResources.filter(item => item.kind === 'pdf' && item.owner === 'user-a' && item.ownership !== 'legacy_unowned' && !item.cloudDocument);
  equal(localOnly.length, expected('M0-28').localOnlyCount, 'owned local-only PDFs');
  equal(new Set([...activeDocs.map(item => item.id), ...localOnly.map(item => item.id)]).size, expected('M0-28').combinedDistinctActiveDocuments, 'cloud/cache/local dedup oracle');
  equal(get('doc-a01').fingerprint, get('doc-b01').fingerprint, 'shared fingerprint adversarial fixture');
  truth(get('doc-a01').owner !== get('doc-b01').owner, 'shared fingerprint must retain separate owners');
  const long = data.messages.filter(item => item.thread === cases.get('M0-29').setup.thread);
  equal(long.length, cases.get('M0-29').setup.messages, 'long-conversation length');
  equal(long[0].content, cases.get('M0-29').setup.initialConstraint, 'old user constraint retained verbatim');
  for (const selection of data.selections) { get(selection.document); truth(selection.selectedText.length > 0, 'selection must contain text'); truth(selection.pages.every(page => Number.isInteger(page) && page > 0), 'selection pages are one-based'); }
  equal(get('selection-a03').verification, 'user_material_only', 'local selection cannot self-verify as artifact');
  truth(get('selection-a02').selectedText !== get('selection-a02').expandedContext, 'selection/context remain separate');
  for (const draft of data.drafts) { equal(get(draft.thread).owner, draft.owner, 'draft/thread owner'); for (const id of draft.attachmentIds) get(id); }
  return { status: 'pass', scope: 'offline_frozen_design_and_fixture_consistency_only', schemaExamples: { validAccepted: examples.valid.length, invalidRejected: examples.invalid.length, total: examples.valid.length + examples.invalid.length },
    fixture: { cases: fixture.cases.length, uniqueIds: cases.size, notExecuted: fixture.cases.filter(item => item.executionStatus === 'not_executed').length, datasetRows: byId.size, assertions: fixtureAssertions },
    budgets: { schemaGuards: budgetGuards.length, aggregateSamples: budgetSamples, units: 'UTF-16 code units; JSON Schema maxLength uses Unicode code points', limits: M0_BUDGETS }, sourceKinds,
    integrationCasesExecuted: 0, modelCalls: 0, databaseConnections: 0 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ ...checkM0(), manifest: checkM0Manifest() }, null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'fail', scope: 'offline_design_consistency', message: error.message }, null, 2)); process.exitCode = 1; }
}
