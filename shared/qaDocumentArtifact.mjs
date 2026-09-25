// Browser/Worker compatible document primitives. Source authorization and
// publication against the original parser assets belong to the server adapter.
export const DOCUMENT_ARTIFACT_VERSION = 'document-artifact-v1';
export const READ_REFERENCE_VERSION = 'read-reference-v1';
export const ARTIFACT_LIMITS = Object.freeze({ maxNodes: 20000, maxRegions: 100000,
  maxMappings: 20000, maxSegments: 200000, maxSourceRefs: 200000, maxTextChars: 8000000, maxPages: 10000, maxDepth: 32 });
const kinds = new Set(['section', 'paragraph', 'list', 'table', 'equation', 'code']);
const indexes = new WeakMap();
const encoder = new TextEncoder();

export class ArtifactError extends Error {
  constructor(code, message) { super(message); this.name = 'ArtifactError'; this.code = code; }
}
export function artifactAssert(condition, code, message) {
  if (!condition) throw new ArtifactError(code, message);
}
const validId = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed, required = allowed) {
  artifactAssert(isObject(value) && Object.keys(value).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(value, key)), 'INVALID_ARTIFACT', 'Invalid document object fields.');
}
export function isTextBoundary(text, offset) {
  return integer(offset) && offset <= text.length && !(offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}
export function assertTextRange(text, range) {
  artifactAssert(typeof text === 'string' && Array.isArray(range) && range.length === 2
    && isTextBoundary(text, range[0]) && isTextBoundary(text, range[1]) && range[0] < range[1],
  'INVALID_TEXT_RANGE', 'A text range must be a non-empty UTF-16 interval without split surrogate pairs.');
}
function assertSource(source) {
  fields(source, ['pdfSha256', 'mmdSha256', 'pagesSha256', 'builderVersion', 'mappingVersion']);
  artifactAssert(['pdfSha256', 'mmdSha256', 'pagesSha256'].every(key => validDigest(source[key]))
    && ['builderVersion', 'mappingVersion'].every(key => typeof source[key] === 'string'
      && /^[a-z0-9][a-z0-9.-]{0,95}$/.test(source[key])), 'INVALID_ARTIFACT_SOURCE', 'Invalid document source identity.');
}
export async function createDocumentRevision(source) {
  assertSource(source);
  const input = [DOCUMENT_ARTIFACT_VERSION, source.pdfSha256, source.mmdSha256, source.pagesSha256,
    source.builderVersion, source.mappingVersion];
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(input)));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export function createNodeId(kind, sourceRange, occurrence = 0) {
  artifactAssert(kinds.has(kind) && Array.isArray(sourceRange) && sourceRange.length === 2
    && sourceRange.every(integer) && sourceRange[0] < sourceRange[1] && integer(occurrence),
  'INVALID_NODE_ID', 'A node needs a source occurrence, not just its text hash.');
  return `n_${kind}_${sourceRange[0]}_${sourceRange[1]}_${occurrence}`;
}

// This validates the structural contract only. It does not establish that a
// client supplied source hash or alignment describes the authorized PDF.
export function validateDocumentArtifact(artifact) {
  fields(artifact, ['version', 'revision', 'source', 'pageCount', 'nodes', 'regions', 'mappings']);
  artifactAssert(artifact.version === DOCUMENT_ARTIFACT_VERSION && validDigest(artifact.revision),
    'INVALID_ARTIFACT_VERSION', 'Unsupported document artifact version.');
  assertSource(artifact.source);
  const { nodes, regions, mappings, pageCount } = artifact;
  artifactAssert(integer(pageCount) && pageCount > 0 && pageCount <= ARTIFACT_LIMITS.maxPages,
    'ARTIFACT_LIMIT', 'Invalid document page count.');
  for (const [items, limit] of [[nodes, ARTIFACT_LIMITS.maxNodes], [regions, ARTIFACT_LIMITS.maxRegions],
    [mappings, ARTIFACT_LIMITS.maxMappings]]) {
    artifactAssert(Array.isArray(items) && items.length <= limit, 'ARTIFACT_LIMIT', 'Document item limit exceeded.');
  }
  artifactAssert(nodes.length > 0, 'INVALID_ARTIFACT', 'The document has no logical nodes.');
  const byNode = new Map(), byRegion = new Map(), byMapping = new Map();
  let textChars = 0, segmentCount = 0, sourceRefCount = 0;
  function countText(text) {
    artifactAssert(typeof text === 'string', 'INVALID_ARTIFACT', 'Document text must be a string.');
    textChars += text.length;
    artifactAssert(textChars <= ARTIFACT_LIMITS.maxTextChars, 'ARTIFACT_LIMIT', 'Document text limit exceeded.');
  }
  for (const node of nodes) {
    fields(node, ['id', 'kind', 'text', 'sourceRange', 'parentId', 'level'], ['id', 'kind', 'text', 'sourceRange']);
    artifactAssert(validId(node.id) && !byNode.has(node.id) && kinds.has(node.kind),
      'INVALID_ARTIFACT_NODE', 'Invalid or duplicate logical node.');
    countText(node.text);
    artifactAssert(node.text.trim().length > 0 && Array.isArray(node.sourceRange) && node.sourceRange.length === 2
      && node.sourceRange.every(integer) && node.sourceRange[0] < node.sourceRange[1],
    'INVALID_ARTIFACT_NODE', 'A logical node needs text and an original source range.');
    artifactAssert(node.parentId === undefined || validId(node.parentId), 'INVALID_ARTIFACT_NODE', 'Invalid parent node.');
    artifactAssert(node.kind === 'section' ? integer(node.level) && node.level >= 1 && node.level <= 6
      : node.level === undefined, 'INVALID_ARTIFACT_NODE', 'Only section nodes have heading levels.');
    byNode.set(node.id, node);
  }
  const sectionPaths = new Map();
  for (const node of nodes) {
    const visited = new Set([node.id]), path = [];
    let parentId = node.parentId, childLevel = node.kind === 'section' ? node.level : 7;
    while (parentId !== undefined) {
      const parent = byNode.get(parentId);
      artifactAssert(parent?.kind === 'section' && !visited.has(parentId) && parent.level < childLevel
        && path.length < ARTIFACT_LIMITS.maxDepth, 'INVALID_ARTIFACT_TREE', 'Invalid or cyclic section hierarchy.');
      visited.add(parentId); path.unshift(parent.text); childLevel = parent.level; parentId = parent.parentId;
    }
    sectionPaths.set(node.id, path);
  }
  for (const region of regions) {
    fields(region, ['id', 'kind', 'pageNumber', 'lineNumber', 'text', 'rect'], ['id', 'kind', 'pageNumber', 'lineNumber', 'text']);
    artifactAssert(validId(region.id) && !byRegion.has(region.id) && integer(region.pageNumber)
      && ['line', 'block'].includes(region.kind) && region.pageNumber >= 1 && region.pageNumber <= pageCount
      && integer(region.lineNumber) && region.lineNumber >= 1,
    'INVALID_ARTIFACT_REGION', 'Invalid or duplicate physical region.');
    countText(region.text);
    if (region.rect !== undefined) {
      fields(region.rect, ['x', 'y', 'width', 'height']);
      const { x, y, width, height } = region.rect;
      artifactAssert([x, y, width, height].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
        && x + width <= 1.000001 && y + height <= 1.000001, 'INVALID_ARTIFACT_REGION', 'Region coordinates must be normalized.');
    }
    byRegion.set(region.id, region);
  }
  for (const mapping of mappings) {
    fields(mapping, ['nodeId', 'segments', 'pageAnchor'], ['nodeId', 'segments']);
    const node = byNode.get(mapping.nodeId);
    artifactAssert(node && !byMapping.has(node.id) && Array.isArray(mapping.segments),
      'INVALID_SOURCE_MAP', 'Invalid or duplicate node mapping.');
    artifactAssert(mapping.pageAnchor === undefined || integer(mapping.pageAnchor)
      && mapping.pageAnchor >= 1 && mapping.pageAnchor <= pageCount, 'INVALID_SOURCE_MAP', 'Invalid page anchor.');
    let previousEnd = 0;
    for (const segment of mapping.segments) {
      artifactAssert(++segmentCount <= ARTIFACT_LIMITS.maxSegments, 'ARTIFACT_LIMIT', 'Source map segment limit exceeded.');
      fields(segment, ['range', 'sources', 'transform']);
      assertTextRange(node.text, segment.range);
      artifactAssert(segment.range[0] >= previousEnd && ['identity', 'reflow', 'line-wrap', 'structural'].includes(segment.transform)
        && Array.isArray(segment.sources) && segment.sources.length > 0 && segment.sources.length <= 256,
      'INVALID_SOURCE_MAP', 'Source map segments must be ordered and bounded.');
      previousEnd = segment.range[1];
      for (const source of segment.sources) {
        artifactAssert(++sourceRefCount <= ARTIFACT_LIMITS.maxSourceRefs, 'ARTIFACT_LIMIT', 'Source reference limit exceeded.');
        fields(source, ['regionId', 'range']);
        const region = byRegion.get(source.regionId);
        artifactAssert(region, 'INVALID_SOURCE_MAP', 'A mapping references an unknown physical region.');
        assertTextRange(region.text, source.range);
      }
      if (segment.transform === 'identity') {
        const source = segment.sources[0];
        artifactAssert(segment.sources.length === 1 && node.text.slice(...segment.range)
          === byRegion.get(source.regionId).text.slice(...source.range), 'INVALID_SOURCE_MAP', 'An identity mapping must preserve the exact source text.');
      }
    }
    byMapping.set(node.id, mapping);
  }
  return { byNode, byRegion, byMapping, sectionPaths };
}
function freeze(value) {
  for (const child of Object.values(value)) if (child !== null && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}
export async function sealDocumentArtifact(artifact) {
  validateDocumentArtifact(artifact); // Bound allocations before cloning.
  const copy = structuredClone(artifact);
  artifactAssert(copy.revision === await createDocumentRevision(copy.source), 'ARTIFACT_REVISION_MISMATCH', 'Document revision does not match its source identity.');
  const index = validateDocumentArtifact(copy);
  freeze(copy); indexes.set(copy, index); return copy;
}
function indexFor(artifact) {
  const index = indexes.get(artifact);
  artifactAssert(index, 'UNSEALED_ARTIFACT', 'Load, validate and seal an artifact before issuing references.');
  return index;
}
export function getDocumentNode(artifact, nodeId) {
  const node = indexFor(artifact).byNode.get(nodeId);
  artifactAssert(node, 'UNKNOWN_DOCUMENT_NODE', 'The node does not exist in this document revision.');
  return node;
}
export function getSectionPath(artifact, nodeId) {
  getDocumentNode(artifact, nodeId);
  return [...indexFor(artifact).sectionPaths.get(nodeId)];
}

export function resolveDocumentLocation(artifact, nodeId, range) {
  const node = getDocumentNode(artifact, nodeId);
  range ??= [0, node.text.length]; assertTextRange(node.text, range);
  const index = indexFor(artifact), mapping = index.byMapping.get(nodeId);
  const intervals = [], sources = new Map();
  let firstAnchor;
  for (const segment of mapping?.segments ?? []) {
    const start = Math.max(range[0], segment.range[0]), end = Math.min(range[1], segment.range[1]);
    if (start >= end) continue;
    const firstRegion = index.byRegion.get(segment.sources[0].regionId);
    const partialSegment = start !== segment.range[0] || end !== segment.range[1];
    if (partialSegment && (segment.sources.length > 1 || index.byRegion.get(segment.sources[0].regionId).kind === 'block')) {
      // A partial range inside a coarse multi-line/table mapping does not tell
      // us which lines support it. Retain a page anchor, not invented precision.
      firstAnchor ??= { pageNumber: firstRegion.pageNumber };
      continue;
    }
    firstAnchor ??= { pageNumber: firstRegion.pageNumber, lineNumber: firstRegion.lineNumber };
    intervals.push([start, end]);
    for (const source of segment.sources) {
      const region = index.byRegion.get(source.regionId);
      // Whole-line highlighting may be wider than read coverage. Do not infer
      // that every character in these physical rectangles was sent to a model.
      sources.set(`${region.id}:${source.range[0]}:${source.range[1]}`, { region, range: source.range });
    }
  }
  let cursor = range[0], complete = true;
  for (const [start, end] of intervals) {
    if (node.text.slice(cursor, start).trim()) complete = false;
    cursor = end;
  }
  if (node.text.slice(cursor, range[1]).trim()) complete = false;
  const parts = [...sources.values()].sort((a, b) => a.region.pageNumber - b.region.pageNumber
    || a.region.lineNumber - b.region.lineNumber || a.range[0] - b.range[0]);
  const lineRegions = [...new Map(parts.filter(p => p.region.rect).map(({ region }) => [region.id,
    { pageNumber: region.pageNumber, lineNumber: region.lineNumber, region: region.rect }])).values()];
  const anchor = firstAnchor ?? (mapping?.pageAnchor ? { pageNumber: mapping.pageAnchor } : undefined);
  const precise = complete && parts.length > 0 && parts.every(p => p.region.rect);
  return { nodeId, range: [...range], anchor, mappingComplete: complete && parts.length > 0,
    precision: precise ? parts.some(p => p.region.kind === 'block') ? 'block' : 'line'
      : lineRegions.length ? 'partial-line' : anchor ? 'page' : 'unavailable',
    sourceSpans: parts.map(({ region, range: span }) => ({ regionId: region.id, pageNumber: region.pageNumber,
      lineNumber: region.lineNumber, startOffset: span[0], endOffset: span[1] })), lineRegions };
}
