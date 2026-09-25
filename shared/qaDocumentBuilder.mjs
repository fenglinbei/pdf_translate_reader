import { ARTIFACT_LIMITS, DOCUMENT_ARTIFACT_VERSION, artifactAssert, createDocumentRevision,
  sealDocumentArtifact, validateDocumentArtifact } from './qaDocumentArtifact.mjs';
import { canonicalizeLayout, createAlignmentIndex, alignDocumentNode } from './qaDocumentAlignment.mjs';
import { parseMmdStructure } from './qaDocumentStructure.mjs';

export const DOCUMENT_BUILDER_VERSION = 'mmd-structure-v1';
export const DOCUMENT_MAPPING_VERSION = 'context-line-map-v1';
export const PREPARATION_CHECKPOINT_VERSION = 'document-preparation-v1';
const encoder = new TextEncoder();
export async function sha256Text(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}
export async function inspectDocumentInputs(input) {
  const layout = canonicalizeLayout(input.pages, input.pageCount);
  const structure = parseMmdStructure(input.mmd, layout.pageCount);
  const source = { pdfSha256: input.pdfSha256, mmdSha256: await sha256Text(input.mmd),
    pagesSha256: await sha256Text(JSON.stringify({ pageCount: layout.pageCount, pages: layout.canonicalPages })),
    builderVersion: DOCUMENT_BUILDER_VERSION, mappingVersion: DOCUMENT_MAPPING_VERSION };
  const revision = await createDocumentRevision(source);
  return { layout, structure, source, revision };
}

// The worker checkpoints every bounded batch. Terminating the worker stops CPU
// work immediately; the next worker can resume only the same source revision.
// A checkpoint is an untrusted local optimization, never a publication proof.
export async function buildDocumentArtifact(input, options = {}) {
  options.signal?.throwIfAborted();
  const { layout, structure, source, revision } = await inspectDocumentInputs(input);
  const artifact = { version: DOCUMENT_ARTIFACT_VERSION, revision, source, pageCount: layout.pageCount,
    nodes: structure.nodes, regions: layout.regions, mappings: [] };
  const checkpoint = options.checkpoint ?? await options.loadCheckpoint?.(revision);
  let nextNode = 0;
  if (checkpoint?.version === PREPARATION_CHECKPOINT_VERSION && checkpoint.revision === revision) {
    artifactAssert(Number.isSafeInteger(checkpoint.nextNode) && checkpoint.nextNode >= 0 && checkpoint.nextNode <= structure.nodes.length
      && Array.isArray(checkpoint.mappings) && checkpoint.mappings.length === checkpoint.nextNode
      && checkpoint.mappings.every((mapping, index) => mapping.nodeId === structure.nodes[index].id),
    'INVALID_PREPARATION_CHECKPOINT', 'The preparation checkpoint does not match its nodes.');
    validateDocumentArtifact({ ...artifact, mappings: checkpoint.mappings });
    artifact.mappings = structuredClone(checkpoint.mappings); nextNode = checkpoint.nextNode;
  }
  const resumedNodes = nextNode;
  options.onProgress?.({ phase: 'structure', completed: nextNode, total: structure.nodes.length, revision });
  await options.yieldControl?.(); options.signal?.throwIfAborted();
  const alignment = nextNode < structure.nodes.length ? createAlignmentIndex(layout.regions) : undefined;
  const batchSize = 24;
  for (; nextNode < structure.nodes.length;) {
    const until = Math.min(nextNode + batchSize, structure.nodes.length);
    for (; nextNode < until; nextNode++) {
      options.signal?.throwIfAborted();
      artifact.mappings.push(alignDocumentNode(structure.nodes[nextNode], structure.hints[nextNode], alignment));
    }
    artifactAssert(artifact.mappings.reduce((sum, mapping) => sum + mapping.segments.length, 0) <= ARTIFACT_LIMITS.maxSegments,
      'ARTIFACT_LIMIT', 'Too many source mapping segments.');
    await options.onCheckpoint?.({ version: PREPARATION_CHECKPOINT_VERSION, revision, nextNode, mappings: artifact.mappings });
    options.onProgress?.({ phase: 'mapping', completed: nextNode, total: structure.nodes.length, revision });
    await options.yieldControl?.(); options.signal?.throwIfAborted();
  }
  const sealed = await sealDocumentArtifact(artifact);
  const mappedChars = artifact.mappings.reduce((sum, mapping) => sum + mapping.segments.reduce((n, segment) => n + segment.range[1] - segment.range[0], 0), 0);
  return { artifact: sealed, stats: { ...(alignment?.stats ?? { tokenCount: 0, suppressedAliases: 0, probes: 0 }), resumedNodes, nodes: structure.nodes.length,
    regions: layout.regions.length, mappedChars, logicalChars: structure.nodes.reduce((sum, node) => sum + node.text.length, 0),
    hasPageHints: structure.hasPageHints } };
}
