import { buildDocumentArtifact, type DocumentBuildInput, type PreparationCheckpoint } from '../../../shared/qaDocumentBuilder.mjs';
import { getPreparedCandidate, savePreparedCandidate, type PreparationScope } from './preparationCache';

type WorkerRequest = { input: DocumentBuildInput; scope: PreparationScope };
const host = self as unknown as { onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null; postMessage: (message: unknown) => void };
let started = false;
host.onmessage = event => {
  if (started) return;
  started = true;
  void (async () => {
    const { input, scope } = event.data;
    if (!scope?.userId || !scope.documentId) throw new Error('Preparation requires a user and document.');
    let cacheAvailable = true;
    const result = await buildDocumentArtifact(input, {
      loadCheckpoint: async revision => {
        try {
          const candidate = await getPreparedCandidate(scope, revision);
          // Finished local candidates remain untrusted and are re-sealed by the
          // builder. Reusing their mappings avoids a second alignment search.
          if (candidate?.result) return { version: 'document-preparation-v1', revision,
            nextNode: candidate.result.artifact.nodes.length, mappings: candidate.result.artifact.mappings };
          return candidate?.checkpoint;
        } catch { cacheAvailable = false; return undefined; }
      },
      onCheckpoint: async (checkpoint: PreparationCheckpoint) => {
        if (!cacheAvailable) return;
        try { cacheAvailable = await savePreparedCandidate(scope, checkpoint.revision, { checkpoint }); }
        catch { cacheAvailable = false; }
      },
      onProgress: progress => host.postMessage({ type: 'progress', progress, cacheAvailable }),
      yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)),
    });
    if (cacheAvailable) {
      try { cacheAvailable = await savePreparedCandidate(scope, result.artifact.revision, { result }); }
      catch { cacheAvailable = false; }
    }
    host.postMessage({ type: 'complete', result, cacheAvailable });
  })().catch(error => host.postMessage({ type: 'error', code: error?.code ?? 'PREPARATION_FAILED',
    message: error instanceof Error ? error.message : 'Document preparation failed.' }));
};
