import { createDocumentRevision, createNodeId, DOCUMENT_ARTIFACT_VERSION } from '../../shared/qaDocumentArtifact.mjs';

// Synthetic canonical text and explicit source maps. This fixture exercises
// the new contract; it is not an OCR/MMD builder or a private paper extract.
export async function documentArtifactFixture() {
  const source = { pdfSha256: '1'.repeat(64), mmdSha256: '2'.repeat(64), pagesSha256: '3'.repeat(64),
    builderVersion: 'fixture-1', mappingVersion: 'fixture-1' };
  const heading = { id: createNodeId('section', [0, 13]), kind: 'section', text: 'Experiments', sourceRange: [0, 13], level: 1 };
  const audit = { id: createNodeId('section', [15, 29]), kind: 'section', text: 'Human Audit', sourceRange: [15, 29], parentId: heading.id, level: 2 };
  const word = { id: createNodeId('paragraph', [31, 39]), kind: 'paragraph', text: 'moderate', sourceRange: [31, 39], parentId: audit.id };
  const repeated = { id: createNodeId('paragraph', [41, 49]), kind: 'paragraph', text: 'moderate', sourceRange: [41, 49], parentId: audit.id };
  const para = { id: createNodeId('paragraph', [51, 75]), kind: 'paragraph', text: 'First claim. Next claim.', sourceRange: [51, 75], parentId: heading.id };
  const table = { id: createNodeId('table', [77, 90]), kind: 'table', text: 'Name | Value', sourceRange: [77, 90], parentId: heading.id };
  const unicode = { id: createNodeId('paragraph', [92, 101]), kind: 'paragraph', text: 'A😀 café', sourceRange: [92, 101], parentId: heading.id };
  const region = (id, pageNumber, lineNumber, text, kind = 'line') => ({ id, kind, pageNumber, lineNumber, text,
    rect: { x: 0.1, y: lineNumber / 100, width: 0.6, height: 0.01 } });
  const regions = [region('p1_l1', 1, 1, 'mod'), region('p1_l2', 1, 2, 'erate'), region('p2_l1', 2, 1, 'moderate'),
    region('p1_l3', 1, 3, 'First claim.'), region('p2_l3', 2, 3, 'Next claim.'),
    region('p2_table', 2, 5, 'Name | Value', 'block'), region('p2_l6', 2, 6, 'A😀 cafe\u0301')];
  const segment = (range, regionId, sourceRange, transform = 'identity') => ({ range, sources: [{ regionId, range: sourceRange }], transform });
  const artifact = { version: DOCUMENT_ARTIFACT_VERSION, revision: await createDocumentRevision(source), source,
    pageCount: 2, nodes: [heading, audit, word, repeated, para, table, unicode], regions,
    mappings: [
      { nodeId: word.id, segments: [{ range: [0, 8], sources: [{ regionId: 'p1_l1', range: [0, 3] }, { regionId: 'p1_l2', range: [0, 5] }], transform: 'line-wrap' }] },
      { nodeId: repeated.id, segments: [segment([0, 8], 'p2_l1', [0, 8])] },
      { nodeId: para.id, segments: [segment([0, 12], 'p1_l3', [0, 12]), segment([13, 24], 'p2_l3', [0, 11])] },
      { nodeId: table.id, segments: [segment([0, 12], 'p2_table', [0, 12], 'structural')] },
      { nodeId: unicode.id, segments: [segment([0, 8], 'p2_l6', [0, 9], 'reflow')] },
    ] };
  return { artifact, heading, audit, word, repeated, para, table, unicode };
}
