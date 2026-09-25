import { READ_REFERENCE_VERSION, artifactAssert, assertTextRange, getDocumentNode, getSectionPath,
  resolveDocumentLocation } from '../../../shared/qaDocumentArtifact.mjs';

const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
// Server-owned ledger, not an endpoint accepting a browser's claim of reading.
// The caller authorizes each document before registration and rechecks access
// when committing an answer. No permission decision is cached here.
export function createReadReferenceRegistry({ userId, runId, maxReturnedChars = 96000, maxReferences = 512 }) {
  artifactAssert(validScope(userId) && validScope(runId), 'INVALID_READ_SCOPE', 'A reading ledger needs a user and run.');
  artifactAssert([maxReturnedChars, maxReferences].every(value => Number.isSafeInteger(value) && value > 0),
    'INVALID_READ_BUDGET', 'Read budgets must be positive integers.');
  const byRef = new Map(), byKey = new Map(), documents = new Map();
  let returnedChars = 0;
  function registerBatch(items) {
    artifactAssert(Array.isArray(items) && items.length > 0 && items.length <= maxReferences,
      'INVALID_READ_BATCH', 'Invalid reading batch.');
    const staged = new Map(), stagedDocuments = new Map(), output = [];
    let additionalChars = 0;
    for (const item of items) {
      artifactAssert(item && validScope(item.documentId), 'INVALID_READ_SCOPE', 'A source needs an authorized document identity.');
      const { artifact, nodeId, documentId } = item;
      const node = getDocumentNode(artifact, nodeId);
      const pinned = documents.get(documentId) ?? stagedDocuments.get(documentId);
      artifactAssert(!pinned || pinned.revision === artifact.revision, 'DOCUMENT_REVISION_CHANGED', 'A document revision is pinned for the duration of a run.');
      artifactAssert(!pinned || pinned === artifact, 'DOCUMENT_SNAPSHOT_CHANGED', 'Reuse the same immutable document snapshot throughout a run.');
      stagedDocuments.set(documentId, artifact);
      artifactAssert(node.kind !== 'section', 'NAVIGATION_IS_NOT_EVIDENCE', 'Reading a heading does not read its chapter.');
      const range = item.range ?? [0, node.text.length]; assertTextRange(node.text, range);
      const text = node.text.slice(range[0], range[1]);
      artifactAssert(text.trim(), 'EMPTY_READ_RANGE', 'Whitespace alone is not readable evidence.');
      additionalChars += text.length;
      artifactAssert(returnedChars + additionalChars <= maxReturnedChars, 'READ_BUDGET_EXHAUSTED', 'Returned reading text exceeds the run budget.');
      const key = JSON.stringify([documentId, artifact.revision, nodeId, ...range]);
      let stored = byKey.get(key) ?? staged.get(key);
      if (!stored) {
        artifactAssert(byRef.size + staged.size < maxReferences, 'READ_BUDGET_EXHAUSTED', 'Read reference limit exceeded.');
        stored = { ref: `R${byRef.size + staged.size + 1}`, key, artifact, nodeId, documentId, range: [...range] };
        staged.set(key, stored);
      }
      output.push({ ref: stored.ref, kind: node.kind, text, sectionPath: getSectionPath(artifact, nodeId),
        coverage: range[0] === 0 && range[1] === node.text.length ? 'full' : 'partial' });
    }
    // Only sources actually returned by a successful batch become citable.
    for (const [key, stored] of staged) { byKey.set(key, stored); byRef.set(stored.ref, stored); }
    for (const [documentId, artifact] of stagedDocuments) documents.set(documentId, artifact);
    returnedChars += additionalChars;
    return output;
  }
  return {
    registerBatch,
    resolve(ref, scope) {
      artifactAssert(scope?.userId === userId && scope?.runId === runId, 'READ_SCOPE_MISMATCH', 'The reference belongs to another user or run.');
      const stored = typeof ref === 'string' ? byRef.get(ref) : undefined;
      artifactAssert(stored, 'UNKNOWN_READ_REFERENCE', 'Only handles issued in this run may be cited.');
      const { artifact, nodeId, range, documentId } = stored;
      const node = getDocumentNode(artifact, nodeId);
      return { version: READ_REFERENCE_VERSION, ref, documentId, revision: artifact.revision, nodeId,
        range: [...range], text: node.text.slice(range[0], range[1]), sectionPath: getSectionPath(artifact, nodeId),
        location: resolveDocumentLocation(artifact, nodeId, range) };
    },
    get metrics() { return { returnedChars, references: byRef.size }; },
  };
}
