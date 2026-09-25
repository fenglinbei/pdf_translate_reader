import { artifactAssert, ARTIFACT_LIMITS, createDocumentRevision, isTextBoundary, sealDocumentArtifact } from './qaDocumentArtifact.mjs';
import { sha256Text } from './qaDocumentBuilder.mjs';

export const DOCUMENT_MANIFEST_VERSION = 'document-manifest-v1';
export const DOCUMENT_PART_VERSION = 'document-part-v1';
export const PART_LIMITS = Object.freeze({ textChars: 12000, segments: 64, targetPartBytes: 128 * 1024, maxPartEntries: 64,
  maxPartBytes: 512 * 1024, maxManifestBytes: 4 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024, maxParts: 40000 });
const encoder = new TextEncoder();
export const jsonByteLength = value => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export function getPartCoverage(manifest, partId, nodeId) {
  return manifest.parts[partId]?.coverage.find(entry => entry.nodeId === nodeId)?.range;
}

// Bounded transport bundles contain adjacent nodes. They do not define reading
// units: each node/range retains its identity and requires its own read receipt.
export async function packDocumentArtifact(candidate) {
  const artifact = await sealDocumentArtifact(candidate);
  const { revision, source, pageCount } = artifact;
  const regions = new Map(artifact.regions.map(region => [region.id, region]));
  const mappings = new Map(artifact.mappings.map(mapping => [mapping.nodeId, mapping]));
  const manifest = { version: DOCUMENT_MANIFEST_VERSION, revision, source, pageCount, nodes: [], parts: {}, totalBytes: 0 };
  const files = [], byNode = new Map();
  const pending = { reading: [], location: [] };
  function encode(kind, entries) {
    const value = { version: DOCUMENT_PART_VERSION, revision, kind, entries };
    if (kind === 'location') {
      const ids = [...new Set(entries.flatMap(entry => entry.segments.flatMap(segment => segment.sources.map(item => item.regionId))))];
      value.regions = ids.map(id => regions.get(id));
    }
    return JSON.stringify(value);
  }
  async function flush(kind) {
    const entries = pending[kind]; if (!entries.length) return;
    const id = (kind === 'reading' ? 'r_' : 'l_') + String(files.length + 1).padStart(6, '0');
    const text = encode(kind, entries), bytes = jsonByteLength(text);
    artifactAssert(bytes <= PART_LIMITS.maxPartBytes && files.length < PART_LIMITS.maxParts,
      'DOCUMENT_PART_LIMIT', 'A document transport part exceeds its limit.');
    manifest.totalBytes += bytes;
    artifactAssert(manifest.totalBytes <= PART_LIMITS.maxTotalBytes, 'DOCUMENT_PART_LIMIT', 'Document transfer limit exceeded.');
    manifest.parts[id] = { kind, coverage: entries.map(({ nodeId, range }) => ({ nodeId, range })), bytes, sha256: await sha256Text(text) };
    for (const entry of entries) byNode.get(entry.nodeId)[kind === 'reading' ? 'readingParts' : 'locationParts'].push(id);
    files.push({ id, text }); pending[kind] = [];
  }
  async function add(kind, entry) {
    const current = pending[kind];
    if (current.length && (current.length >= PART_LIMITS.maxPartEntries || current.some(item => item.nodeId === entry.nodeId)
      || jsonByteLength(encode(kind, [...current, entry])) > PART_LIMITS.targetPartBytes)) await flush(kind);
    pending[kind].push(entry);
  }
  for (const node of artifact.nodes) {
    const { text, ...identity } = node, mapping = mappings.get(node.id), pageSlices = [];
    for (const segment of mapping?.segments ?? []) {
      for (const pageNumber of new Set(segment.sources.map(item => regions.get(item.regionId).pageNumber))) {
        const previous = pageSlices.at(-1);
        if (previous?.pageNumber === pageNumber && previous.range[1] <= segment.range[0]
          && !text.slice(previous.range[1], segment.range[0]).trim()) previous.range[1] = segment.range[1];
        else pageSlices.push({ range: [...segment.range], pageNumber });
      }
    }
    const entry = { ...identity, textLength: text.length, ...(node.kind === 'section' ? { title: text } : {}),
      ...(mapping?.pageAnchor ? { pageAnchor: mapping.pageAnchor } : {}), pageSlices, readingParts: [], locationParts: [] };
    manifest.nodes.push(entry); byNode.set(node.id, entry);
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + PART_LIMITS.textChars, text.length);
      if (!isTextBoundary(text, end)) end--;
      await add('reading', { nodeId: node.id, range: [start, end], text: text.slice(start, end) }); start = end;
    }
    const segments = mapping?.segments ?? [];
    for (let i = 0; i < segments.length; i += PART_LIMITS.segments) {
      const batch = segments.slice(i, i + PART_LIMITS.segments);
      await add('location', { nodeId: node.id, range: [batch[0].range[0], batch.at(-1).range[1]], segments: batch });
    }
  }
  await flush('reading'); await flush('location');
  const text = JSON.stringify(manifest);
  artifactAssert(jsonByteLength(text) <= PART_LIMITS.maxManifestBytes, 'DOCUMENT_PART_LIMIT', 'Document manifest limit exceeded.');
  await sealDocumentManifest(manifest);
  return { manifest: freeze(manifest), manifestText: text, manifestSha256: await sha256Text(text), files };
}

export async function sealDocumentManifest(manifest) {
  artifactAssert(manifest?.version === DOCUMENT_MANIFEST_VERSION && manifest.revision === await createDocumentRevision(manifest.source),
    'INVALID_DOCUMENT_MANIFEST', 'The manifest revision does not match its source.');
  artifactAssert(Number.isSafeInteger(manifest.pageCount) && manifest.pageCount > 0 && manifest.pageCount <= ARTIFACT_LIMITS.maxPages
    && Array.isArray(manifest.nodes) && manifest.nodes.length > 0 && manifest.nodes.length <= ARTIFACT_LIMITS.maxNodes
    && manifest.parts && typeof manifest.parts === 'object' && !Array.isArray(manifest.parts)
    && Object.keys(manifest.parts).length <= PART_LIMITS.maxParts && jsonByteLength(manifest) <= PART_LIMITS.maxManifestBytes,
  'INVALID_DOCUMENT_MANIFEST', 'Invalid manifest bounds.');
  const byNode = new Map(), used = new Set(); let bytes = 0, textChars = 0, coverageCount = 0;
  for (const [id, part] of Object.entries(manifest.parts)) {
    artifactAssert(/^[rl]_\d{6}$/.test(id) && ['reading','location'].includes(part.kind) && /^[a-f0-9]{64}$/.test(part.sha256)
      && Number.isSafeInteger(part.bytes) && part.bytes > 0 && part.bytes <= PART_LIMITS.maxPartBytes
      && Array.isArray(part.coverage) && part.coverage.length > 0 && part.coverage.length <= PART_LIMITS.maxPartEntries,
    'INVALID_DOCUMENT_MANIFEST', 'Invalid part descriptor.');
    bytes += part.bytes;
    const seen = new Set();
    for (const item of part.coverage) {
      artifactAssert(!seen.has(item.nodeId) && Array.isArray(item.range) && item.range.length === 2 && item.range.every(Number.isSafeInteger)
        && item.range[0] >= 0 && item.range[0] < item.range[1], 'INVALID_DOCUMENT_MANIFEST', 'Invalid part coverage.');
      seen.add(item.nodeId); coverageCount++;
    }
  }
  for (const node of manifest.nodes) {
    artifactAssert(typeof node.id === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(node.id) && !byNode.has(node.id)
      && ['section', 'paragraph', 'list', 'table', 'equation', 'code'].includes(node.kind)
      && Number.isSafeInteger(node.textLength) && node.textLength > 0
      && Array.isArray(node.sourceRange) && node.sourceRange.length === 2 && node.sourceRange.every(Number.isSafeInteger)
      && node.sourceRange[0] >= 0 && node.sourceRange[0] < node.sourceRange[1]
      && (node.pageAnchor === undefined || Number.isSafeInteger(node.pageAnchor) && node.pageAnchor > 0 && node.pageAnchor <= manifest.pageCount)
      && (node.kind !== 'section' || typeof node.title === 'string' && node.title.length === node.textLength
        && Number.isSafeInteger(node.level) && node.level >= 1 && node.level <= 6),
    'INVALID_DOCUMENT_MANIFEST', 'Invalid node manifest.');
    byNode.set(node.id, node); textChars += node.textLength;
    artifactAssert(textChars <= ARTIFACT_LIMITS.maxTextChars, 'INVALID_DOCUMENT_MANIFEST', 'Manifest text limit exceeded.');
    artifactAssert(Array.isArray(node.pageSlices) && node.pageSlices.length <= ARTIFACT_LIMITS.maxSegments
      && node.pageSlices.every(slice => Number.isSafeInteger(slice.pageNumber) && slice.pageNumber >= 1 && slice.pageNumber <= manifest.pageCount
        && Array.isArray(slice.range) && slice.range.length === 2 && slice.range.every(Number.isSafeInteger)
        && slice.range[0] >= 0 && slice.range[0] < slice.range[1] && slice.range[1] <= node.textLength),
    'INVALID_DOCUMENT_MANIFEST', 'Invalid page routing intervals.');
    for (const [kind, ids] of [['reading', node.readingParts], ['location', node.locationParts]]) {
      artifactAssert(Array.isArray(ids) && ids.length <= PART_LIMITS.maxParts, 'INVALID_DOCUMENT_MANIFEST', 'Invalid part list.');
      let previousEnd = 0;
      for (const id of ids) {
        const part = manifest.parts[id], range = getPartCoverage(manifest, id, node.id), key = JSON.stringify([id,node.id]);
        artifactAssert(!used.has(key) && part?.kind === kind && range && range[0] >= previousEnd && range[1] <= node.textLength
          && (kind !== 'reading' || range[0] === previousEnd), 'INVALID_DOCUMENT_MANIFEST', 'Invalid, overlapping or missing part coverage.');
        previousEnd = range[1]; used.add(key);
      }
      if (kind === 'reading') artifactAssert(previousEnd === node.textLength, 'INVALID_DOCUMENT_MANIFEST', 'Reading parts must cover the whole node.');
    }
  }
  for (const node of manifest.nodes) {
    const visited = new Set([node.id]); let parent = node.parentId, level = node.kind === 'section' ? node.level : 7;
    while (parent !== undefined) {
      const ancestor = byNode.get(parent);
      artifactAssert(ancestor?.kind === 'section' && ancestor.level < level && !visited.has(parent),
        'INVALID_DOCUMENT_MANIFEST', 'Invalid section hierarchy.');
      visited.add(parent); level = ancestor.level; parent = ancestor.parentId;
    }
  }
  artifactAssert(used.size === coverageCount && manifest.totalBytes === bytes && bytes <= PART_LIMITS.maxTotalBytes,
    'INVALID_DOCUMENT_MANIFEST', 'Manifest size or membership is inconsistent.');
  return freeze(structuredClone(manifest));
}

export async function decodeDocumentPart(manifest, id, text) {
  const expected = manifest.parts[id];
  artifactAssert(expected && jsonByteLength(text) === expected.bytes && await sha256Text(text) === expected.sha256,
    'DOCUMENT_PART_MISMATCH', 'Document part digest or size mismatch.');
  const part = JSON.parse(text);
  artifactAssert(part.version === DOCUMENT_PART_VERSION && part.revision === manifest.revision && part.kind === expected.kind
    && Array.isArray(part.entries) && part.entries.length === expected.coverage.length
    && part.entries.every((entry, i) => entry.nodeId === expected.coverage[i].nodeId
      && JSON.stringify(entry.range) === JSON.stringify(expected.coverage[i].range)
      && (part.kind !== 'reading' || typeof entry.text === 'string' && entry.text.length === entry.range[1] - entry.range[0])),
  'DOCUMENT_PART_MISMATCH', 'Document part identity mismatch.');
  return freeze(part);
}
