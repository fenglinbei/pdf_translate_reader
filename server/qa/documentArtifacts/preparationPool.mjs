import { Worker } from 'node:worker_threads';
import { ArtifactError, artifactAssert } from '../../../shared/qaDocumentArtifact.mjs';

export function validateCandidateInWorker(input, candidateText, { signal, timeoutMs = 60000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./validation.worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate(); if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason ?? new ArtifactError('PREPARATION_CANCELLED', 'Document preparation cancelled.'));
    const timer = setTimeout(() => finish(new ArtifactError('PREPARATION_TIMEOUT', 'Document validation exceeded its CPU time limit.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('error', () => finish(new ArtifactError('PREPARATION_WORKER_FAILED', 'The preparation worker could not complete.')));
    worker.once('exit', code => { if (!settled) finish(new ArtifactError('PREPARATION_WORKER_FAILED', `The preparation worker exited (${code}).`)); });
    worker.once('message', message => message.error ? finish(new ArtifactError(message.error.code, message.error.message)) : finish(undefined, message));
    worker.postMessage({ input, candidateText });
  });
}

// A separate preparation lane. This limit is per process, not a claim of a
// distributed global limiter. Database leases still isolate documents/devices.
export function createPreparationPool({ concurrency = 1, maxQueued = 2, taskTimeoutMs = 120000 } = {}) {
  artifactAssert([concurrency, maxQueued, taskTimeoutMs].every(Number.isSafeInteger) && concurrency > 0 && maxQueued >= 0 && taskTimeoutMs > 0,
    'INVALID_PREPARATION_LIMIT', 'Invalid preparation limits.');
  const queue = []; let active = 0;
  function start() {
    while (active < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift(); active++;
      const signal = AbortSignal.timeout(taskTimeoutMs);
      Promise.resolve().then(() => task(signal)).then(resolve, reject).finally(() => { active--; start(); });
    }
  }
  return { submit(task) {
    if (active >= concurrency && queue.length >= maxQueued) return Promise.reject(Object.assign(new ArtifactError('PREPARATION_BUSY', '文档准备任务已满，请稍后再试。'), { statusCode: 429 }));
    return new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); start(); });
  }, get metrics() { return { active, queued: queue.length, concurrency, maxQueued }; } };
}
