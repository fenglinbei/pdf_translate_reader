import { sealDocumentArtifact } from '../shared/qaDocumentArtifact.mjs';
import { createReadReferenceRegistry } from '../server/qa/documentArtifacts/readReferences.mjs';
import { documentArtifactFixture } from '../tests/fixtures/documentArtifacts.mjs';

const { artifact, word, para } = await documentArtifactFixture();
const sealed = await sealDocumentArtifact(artifact);
const scope = { userId: 'synthetic-user', runId: 'synthetic-run' };
const ledger = createReadReferenceRegistry(scope);
const items = ledger.registerBatch([
  { documentId: 'synthetic-document', artifact: sealed, nodeId: word.id },
  { documentId: 'synthetic-document', artifact: sealed, nodeId: para.id, range: [13, 24] },
]);
console.log(JSON.stringify({ stage: 'S1 primitives; synthetic prebuilt mapping; no model or database calls',
  readingResult: items, citations: items.map(item => ledger.resolve(item.ref, scope)), metrics: ledger.metrics }, null, 2));
