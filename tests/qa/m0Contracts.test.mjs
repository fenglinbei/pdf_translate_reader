import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { checkM0, checkM0Manifest, loadM0Inputs, measureDraftBudget } from '../../scripts/check-qa-m0.mjs';

test('frozen design examples and all 38 future fixture cases are internally consistent', () => {
  const result = checkM0();
  const manifest = checkM0Manifest();
  assert.equal(manifest.status, 'pass');
  assert.equal(manifest.budgetMappingsVerified, 11);
  assert(manifest.artifactsVerified >= 3);
  assert.equal(result.schemaExamples.total, 45);
  assert.equal(result.fixture.notExecuted, 38);
  assert.equal(result.integrationCasesExecuted, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.databaseConnections, 0);
});
test('guard rejects duplicate cases and refuses to relabel fixture checks as integration passes', () => {
  const duplicate = loadM0Inputs(); duplicate.fixture.cases[1].id = duplicate.fixture.cases[0].id;
  assert.throws(() => checkM0(duplicate), /case IDs must be unique/);
  const falselyExecuted = loadM0Inputs(); falselyExecuted.fixture.cases[0].executionStatus = 'passed';
  assert.throws(() => checkM0(falselyExecuted), /not integration execution/);
});
test('independent fixture count detects a document moving to a different owner', () => {
  const input = loadM0Inputs(); input.fixture.datasets.documents[0].owner = 'user-b';
  assert.throws(() => checkM0(input), /active document count/);
});
test('unowned legacy records cannot be silently assigned to the active account', () => {
  const input = loadM0Inputs(); input.fixture.datasets.localResources.find(row => row.ownership === 'legacy_unowned').owner = 'user-a';
  assert.throws(() => checkM0(input), /unclaimed record cannot have assumed owner/);
});
test('budget uses UTF-16 and sums segments, attachments and context independently', () => {
  assert.deepEqual(measureDraftBudget({ question: '😀'.repeat(1000) }).exceeded, []);
  assert.deepEqual(measureDraftBudget({ question: '😀'.repeat(1000) + 'a' }).exceeded, ['questionUtf16']);
  const attachment = chars => ({ selectionSegments: [{ rawText: 'x'.repeat(chars), normalizedText: 'x'.repeat(chars) }], contextSegments: [] });
  assert.deepEqual(measureDraftBudget({ inputAttachments: [attachment(4000)] }).exceeded, []);
  assert.deepEqual(measureDraftBudget({ inputAttachments: [{ selectionSegments: [...attachment(2000).selectionSegments, ...attachment(2001).selectionSegments] }] }).exceeded, ['selectionPerAttachmentUtf16']);
  assert.deepEqual(measureDraftBudget({ inputAttachments: Array.from({ length: 4 }, () => attachment(4000)) }).exceeded, ['selectionTotalUtf16']);
  const context = attachment(10); context.contextSegments = [{ text: '😀'.repeat(2000) + 'a' }];
  assert.deepEqual(measureDraftBudget({ inputAttachments: [context] }).exceeded, ['contextTotalUtf16']);
});
test('review status prose may change while business contract shape remains frozen', () => {
  const input = loadM0Inputs(); input.fixture.status = 'frozen_design_v1'; input.schema.title = 'Reviewed design'; input.schema.$comment = 'Approved';
  assert.equal(checkM0(input).status, 'pass');
});

test('manifest guard rejects escaped paths, changed artifact hashes and budget drift', () => {
  const read = () => JSON.parse(readFileSync(new URL('../../docs/contracts/qa-workspace-m0.freeze.json', import.meta.url), 'utf8'));
  for (const path of ['/etc/passwd', '../outside', 'docs/../outside', 'C:\\outside', 'file:///tmp/outside']) {
    const manifest = read(); manifest.artifacts[0].path = path;
    assert.throws(() => checkM0Manifest(manifest), /unsafe artifact path/);
  }
  const changedHash = read(); changedHash.artifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => checkM0Manifest(changedHash), /hash mismatch/);
  const changedBudget = read(); changedBudget.budgets.futureInput.questionUtf16++;
  assert.throws(() => checkM0Manifest(changedBudget), /manifest budget mismatch/);
});
