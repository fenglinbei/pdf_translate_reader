import { parentPort } from 'node:worker_threads';
import { isDeepStrictEqual } from 'node:util';
import { buildDocumentArtifact } from '../../../shared/qaDocumentBuilder.mjs';
import { artifactAssert, validateDocumentArtifact } from '../../../shared/qaDocumentArtifact.mjs';
import { packDocumentArtifact } from '../../../shared/qaDocumentParts.mjs';

parentPort.once('message', async ({ input, candidateText }) => {
  try {
    const sourceInput = input.pagesText === undefined ? input : { ...input, pages: JSON.parse(input.pagesText) };
    const built = await buildDocumentArtifact(sourceInput);
    if (candidateText !== undefined) {
      const candidate = JSON.parse(candidateText);
      validateDocumentArtifact(candidate);
      // Reproduce the derivation against the authorized source once, off the
      // HTTP/Agent event loop. A client hash or claimed alignment is not proof.
      artifactAssert(isDeepStrictEqual(candidate, built.artifact), 'CANDIDATE_SOURCE_MISMATCH', 'The candidate does not match the authorized parsing inputs.');
    }
    const packed = await packDocumentArtifact(built.artifact);
    parentPort.postMessage({ result: packed, stats: built.stats });
  } catch (error) {
    parentPort.postMessage({ error: { code: error.code ?? 'ARTIFACT_VALIDATION_FAILED', message: 'Document candidate validation failed.' } });
  }
});
