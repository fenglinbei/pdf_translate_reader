import { artifactAssert } from '../../../shared/qaDocumentArtifact.mjs';
import { isArtifactReadReceipt, sliceArtifactReceipt } from './loader.mjs';

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
function sentenceRanges(receipt) {
  // Complex math/code/table content keeps its stable whole-node handle. Do not
  // split at decimal points, TeX commands or punctuation inside a formula.
  if (!['paragraph','list'].includes(receipt.kind) || /[$`]|\\[([]/.test(receipt.text)) return [];
  const ranges = [...segmenter.segment(receipt.text)].map(({ index, segment }) => {
    const left = segment.length - segment.trimStart().length, right = segment.trimEnd().length;
    return [receipt.range[0] + index + left, receipt.range[0] + index + right];
  }).filter(([a,b]) => b > a);
  return ranges.length > 1 && ranges.length <= 32 ? ranges : [];
}
export function createPublishedReferences({ userId, runId, maxReturnedChars = 96000, maxReferences = 2048 }) {
  artifactAssert(userId && runId, 'INVALID_READ_SCOPE', 'A ledger requires user/run identity.');
  const sources = new Map(), keys = new Map(), pinned = new Map(); let returnedChars = 0, next = 1;
  function registerBatch(items) {
    artifactAssert(Array.isArray(items) && items.length > 0 && items.length <= 256, 'INVALID_READ_BATCH', 'Invalid receipt batch.');
    const staged = new Map(), stagedKeys = new Map(), stagedDocs = new Map(), output = []; let chars = 0, sequence = next;
    for (const { receipt, document, title, pdfFingerprint } of items) {
      artifactAssert(isArtifactReadReceipt(receipt) && receipt.snapshot.userId === userId, 'READ_SCOPE_MISMATCH', 'Use a receipt read for this user.');
      const { snapshot } = receipt, prior = pinned.get(snapshot.documentId) ?? stagedDocs.get(snapshot.documentId);
      artifactAssert(!prior || prior === snapshot, 'DOCUMENT_SNAPSHOT_CHANGED', 'Document snapshot is pinned during a run.');
      stagedDocs.set(snapshot.documentId, snapshot);
      chars += receipt.text.length;
      artifactAssert(returnedChars + chars <= maxReturnedChars, 'READ_BUDGET_EXHAUSTED', '本次已读资料达到上限，请依据现有资料回答。');
      const key = JSON.stringify([snapshot.documentId, snapshot.revision, receipt.nodeId, receipt.range]);
      let ref = keys.get(key) ?? stagedKeys.get(key);
      if (!ref) {
        ref = `R${sequence++}`; stagedKeys.set(key, ref);
        const entry = { receipt, document, title, pdfFingerprint };
        staged.set(ref, entry);
        const ranges = sentenceRanges(receipt);
        entry.sentences = ranges.map(([start,end], index) => {
          const child = `${ref}.${index + 1}`, part = sliceArtifactReceipt(receipt,start,end);
          staged.set(child, { ...entry, receipt: part, sentences: undefined });
          return { ref: child, text: part.text };
        });
      }
      const stored = sources.get(ref) ?? staged.get(ref);
      output.push({ ref, document, kind: receipt.kind, sectionPath: receipt.sectionPath, coverage: receipt.coverage,
        ...(stored.sentences?.length ? { sentences: stored.sentences } : { text: receipt.text }) });
    }
    artifactAssert(sources.size + staged.size <= maxReferences, 'READ_BUDGET_EXHAUSTED', '本次阅读句柄达到上限。');
    for (const [key,ref] of stagedKeys) keys.set(key,ref);
    for (const [ref,item] of staged) sources.set(ref,item);
    for (const [id,snapshot] of stagedDocs) pinned.set(id,snapshot);
    returnedChars += chars; next = sequence; return output;
  }
  function resolve(ref, scope = { userId, runId }) {
    artifactAssert(scope.userId === userId && scope.runId === runId, 'READ_SCOPE_MISMATCH', 'Another run cannot use these handles.');
    const item = sources.get(ref); artifactAssert(item, 'UNKNOWN_READ_REFERENCE', '请使用本次阅读结果中的 R 编号。'); return item;
  }
  function citation(ref, evidenceId) {
    const item = resolve(ref), { receipt } = item, { snapshot } = receipt;
    const node = snapshot.manifest.nodes.find(node => node.id === receipt.nodeId);
    let pages = [...new Set(node.pageSlices.filter(part => part.range[0] < receipt.range[1] && part.range[1] > receipt.range[0]).map(part => part.pageNumber))].sort((a,b) => a-b);
    if (!pages.length && node.pageAnchor && receipt.coverage === 'full') pages = [node.pageAnchor];
    const locator = { version: 'citation-locator-v2', evidenceId, revision: snapshot.revision, nodeId: receipt.nodeId, range: [...receipt.range],
      pdfSha256: snapshot.manifest.source.pdfSha256, manifestSha256: snapshot.manifestSha256,
      ...(snapshot.storagePrefix ? { manifestPath: snapshot.storagePrefix + 'manifest.json' } : {}),
      pages, ...(pages.length ? { anchor: { pageNumber: pages[0] } } : {}), kind: receipt.kind,
      locationPrecision: pages.length ? 'pending' : 'unavailable' };
    return { sourceKind: 'document_artifact', sourceVersion: snapshot.revision, sourceRecordId: snapshot.revision,
      evidenceKey: `${receipt.nodeId}:${receipt.range.join(':')}`, sourceLocator: locator, evidenceId,
      cloudDocumentId: snapshot.documentId, documentTitle: item.title, pdfFingerprint: item.pdfFingerprint,
      pageStart: pages[0] ?? null, pageEnd: pages.at(-1) ?? null, sectionPath: receipt.sectionPath,
      quotedText: receipt.text.slice(0,700), confidence: 'verified' };
  }
  return { registerBatch, resolve, citation, get metrics() { return { returnedChars, references: sources.size }; } };
}
