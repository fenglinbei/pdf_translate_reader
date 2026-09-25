import { artifactAssert, isTextBoundary, resolveMappedNodeLocation } from '../../../shared/qaDocumentArtifact.mjs';
import { decodeDocumentPart, getPartCoverage, jsonByteLength, PART_LIMITS, sealDocumentManifest } from '../../../shared/qaDocumentParts.mjs';
import { sha256Text } from '../../../shared/qaDocumentBuilder.mjs';
import { createArtifactPartCache } from './partCache.mjs';

const receipts = new WeakSet();
export function isArtifactReadReceipt(value) { return receipts.has(value); }
const immutable = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); } return value; };

// Share bytes and immutable content, never access decisions. A single in-flight
// load is scoped to user + document + revision + part, with a bounded registry.
export function createArtifactLoader({ loadText, authorize, maxBytes = 32 * 1024 * 1024, maxEntries = 256, maxPending = 32 }) {
  const cache = createArtifactPartCache({ maxBytes, maxEntries }), pending = new Map(), manifestHashes = new WeakMap();
  async function cached(scope, maxSize, decode) {
    const hit = cache.get(scope);
    if (hit) return hit;
    const key = JSON.stringify(scope);
    if (pending.has(key)) return pending.get(key).promise;
    artifactAssert(pending.size < maxPending, 'DOCUMENT_LOAD_BUSY', 'Too many pending document part loads.');
    const cacheToken = { allowed: true };
    const work = (async () => {
      const text = await loadText(scope, maxSize);
      artifactAssert(typeof text === 'string' && jsonByteLength(text) <= maxSize, 'DOCUMENT_PART_LIMIT', 'Document part exceeds its transfer limit.');
      const value = await decode(text);
      // Includes a conservative allowance for parsed objects and UTF-16 text.
      if (cacheToken.allowed) cache.set(scope, value, jsonByteLength(text) * 4);
      return value;
    })();
    pending.set(key, { promise: work, userId: scope.userId, cacheToken });
    try { return await work; } finally { pending.delete(key); }
  }
  async function open({ userId, documentId, revision, manifestSha256, storagePrefix }, { signal } = {}) {
    const base = { userId, documentId, revision, ...(storagePrefix ? { storagePrefix } : {}) };
    async function assertAccess() { signal?.throwIfAborted(); await authorize(base); signal?.throwIfAborted(); }
    await assertAccess();
    const manifest = await cached({ ...base, partId: 'manifest' }, PART_LIMITS.maxManifestBytes, async text => {
      artifactAssert(await sha256Text(text) === manifestSha256, 'DOCUMENT_PART_MISMATCH', 'Manifest digest mismatch.');
      const sealed = await sealDocumentManifest(JSON.parse(text));
      artifactAssert(sealed.revision === revision, 'DOCUMENT_PART_MISMATCH', 'Manifest belongs to another revision.');
      manifestHashes.set(sealed, manifestSha256);
      return sealed;
    });
    artifactAssert(manifestHashes.get(manifest) === manifestSha256, 'DOCUMENT_PART_MISMATCH', 'Cached manifest digest mismatch.');
    const nodes = new Map(manifest.nodes.map(node => [node.id, node]));
    function requireNode(id) { const node = nodes.get(id); artifactAssert(node, 'UNKNOWN_DOCUMENT_NODE', 'The reading node does not exist.'); return node; }
    function sectionPath(node) {
      const result = []; let parent = node.parentId;
      while (parent) { const section = nodes.get(parent); result.unshift(section.title); parent = section.parentId; }
      return result;
    }
    async function part(id) {
      const descriptor = manifest.parts[id];
      artifactAssert(descriptor, 'UNKNOWN_DOCUMENT_PART', 'The part is not in this revision.');
      signal?.throwIfAborted();
      const result = await cached({ ...base, partId: id }, descriptor.bytes, text => decodeDocumentPart(manifest, id, text));
      signal?.throwIfAborted(); return result;
    }
    const snapshot = Object.freeze({ ...base, manifest });
    async function readOne(nodeId, { start = 0, maxChars = 8000 } = {}) {
        const node = requireNode(nodeId);
        artifactAssert(node.kind !== 'section', 'NAVIGATION_IS_NOT_EVIDENCE', 'Use the outline for headings and read its body nodes.');
        artifactAssert(Number.isSafeInteger(start) && start >= 0 && start < node.textLength && Number.isSafeInteger(maxChars)
          && maxChars > 0 && maxChars <= 24000, 'INVALID_READ_RANGE', 'Invalid reading interval.');
        let end = Math.min(start + maxChars, node.textLength), text = '';
        for (const id of node.readingParts) {
          const range = getPartCoverage(manifest, id, nodeId);
          if (range[1] <= start || range[0] >= end) continue;
          const value = (await part(id)).entries.find(entry => entry.nodeId === nodeId);
          const from = Math.max(start, range[0]) - range[0];
          let until = Math.min(end, range[1]) - range[0];
          artifactAssert(isTextBoundary(value.text, from), 'INVALID_TEXT_RANGE', 'Reading cannot split a Unicode character.');
          if (!isTextBoundary(value.text, until)) { until--; end--; }
          text += value.text.slice(from, until);
        }
        artifactAssert(text.trim() && text.length === end - start, 'EMPTY_READ_RANGE', 'No readable text in the requested interval.');
        const receipt = immutable({ snapshot, nodeId, kind: node.kind, text, range: [start, end], sectionPath: sectionPath(node),
          coverage: start === 0 && end === node.textLength ? 'full' : 'partial', nextOffset: end < node.textLength ? end : null });
        receipts.add(receipt); return receipt;
    }
    async function readBatch(items) {
      artifactAssert(Array.isArray(items) && items.length > 0 && items.length <= 256,
        'INVALID_READ_BATCH', 'Invalid reading batch.');
      artifactAssert(items.reduce((sum, item) => sum + (item.maxChars ?? 8000), 0) <= 256000,
        'READ_BUDGET_EXHAUSTED', 'Reading batch exceeds the transport budget.');
      await assertAccess(); const values = [];
      for (const item of items) values.push(await readOne(item.nodeId, item));
      await assertAccess(); return values;
    }
    return {
      snapshot, assertAccess, readBatch,
      async read(nodeId, options = {}) { return (await readBatch([{ ...options, nodeId }]))[0]; },
      async locate(receipt) {
        artifactAssert(receipts.has(receipt) && receipt.snapshot === snapshot, 'READ_SCOPE_MISMATCH', 'This receipt belongs to another reading snapshot.');
        await assertAccess();
        const node = requireNode(receipt.nodeId), segments = [], regions = new Map();
        for (const id of node.locationParts) {
          const range = getPartCoverage(manifest, id, node.id);
          if (range[1] <= receipt.range[0] || range[0] >= receipt.range[1]) continue;
          const location = await part(id);
          segments.push(...location.entries.find(entry => entry.nodeId === node.id).segments);
          for (const region of location.regions) regions.set(region.id, region);
        }
        // Source-map resolution inspects only the actually read interval. No
        // additional body text or whole-document layout is loaded here.
        const text = ' '.repeat(receipt.range[0]) + receipt.text + ' '.repeat(node.textLength - receipt.range[1]);
        return resolveMappedNodeLocation({ id: node.id, text }, { nodeId: node.id, segments, pageAnchor: node.pageAnchor }, regions, receipt.range);
      },
    };
  }
  return { open, get metrics() { return { ...cache.metrics, pendingLoads: pending.size }; }, clearUser(userId) {
    for (const load of pending.values()) if (load.userId === userId) load.cacheToken.allowed = false;
    cache.clearUser(userId);
  } };
}
