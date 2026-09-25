import type { DocumentBuildInput, DocumentBuildResult, PreparationProgress } from '../../../shared/qaDocumentBuilder.mjs';
import type { PreparationScope } from './preparationCache';
export { clearPreparedCandidates } from './preparationCache';

let active = false;
export function prepareDocumentInWorker(scope: PreparationScope, input: DocumentBuildInput,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (progress: PreparationProgress) => void } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (active) return Promise.reject(new Error('Another document is being prepared on this client.'));
  active = true;
  return new Promise<DocumentBuildResult & { cacheAvailable: boolean }>((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./preparation.worker.ts', import.meta.url), { type: 'module' }); }
    catch (error) { active = false; reject(error); return; }
    const finish = () => { active = false; clearTimeout(timeout); signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(signal?.reason ?? new DOMException('Preparation cancelled.', 'AbortError')); };
    const timeout = setTimeout(() => { finish(); reject(new Error('Document preparation timed out; it can resume from its saved progress.')); }, 60_000);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = error => { finish(); reject(new Error(error.message || 'Document worker failed.')); };
    worker.onmessage = event => {
      const message = event.data;
      if (message.type === 'progress') onProgress?.(message.progress);
      else if (message.type === 'complete') { finish(); resolve({ ...message.result, cacheAvailable: message.cacheAvailable }); }
      else if (message.type === 'error') { finish(); reject(Object.assign(new Error(message.message), { code: message.code })); }
    };
    worker.postMessage({ scope, input });
  });
}
