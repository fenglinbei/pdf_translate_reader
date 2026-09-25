import { openDB, type DBSchema } from 'idb';
import type { DocumentBuildResult, PreparationCheckpoint } from '../../../shared/qaDocumentBuilder.mjs';

export type PreparationScope = { userId: string; documentId: string };
type CachedPreparation = PreparationScope & { key: string; revision: string; updatedAt: number; estimatedBytes: number;
  checkpoint?: PreparationCheckpoint; result?: DocumentBuildResult };
interface PreparationDb extends DBSchema {
  candidates: { key: string; value: CachedPreparation; indexes: { byUser: string } };
}
// Separate from the reader's IndexedDB schema so an experimental QA Worker
// cannot block a reader database upgrade or rewrite its translation cache.
const dbPromise = () => openDB<PreparationDb>('pdf-reader-qa-preparation-v1', 1, {
  upgrade(db) { db.createObjectStore('candidates', { keyPath: 'key' }).createIndex('byUser', 'userId'); },
});
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const keyFor = (scope: PreparationScope, revision: string) => JSON.stringify([scope.userId, scope.documentId, revision]);
export async function getPreparedCandidate(scope: PreparationScope, revision: string) {
  const db = await dbPromise();
  try { return await db.get('candidates', keyFor(scope, revision)); } finally { db.close(); }
}
export async function savePreparedCandidate(scope: PreparationScope, revision: string,
  value: { checkpoint?: PreparationCheckpoint; result?: DocumentBuildResult }) {
  const estimatedBytes = JSON.stringify(value).length * 2;
  if (estimatedBytes > MAX_CACHE_BYTES) return false;
  const db = await dbPromise();
  try {
    const tx = db.transaction('candidates', 'readwrite');
    const key = keyFor(scope, revision);
    // Only metadata is needed for eviction, but the bounded candidate store
    // remains deliberately small. Cache quota failures never publish a result.
    const entries = (await tx.store.getAll()).filter(entry => entry.key !== key).sort((a, b) => a.updatedAt - b.updatedAt);
    let bytes = estimatedBytes + entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
    while (entries.length >= MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      await tx.store.delete(oldest.key); bytes -= oldest.estimatedBytes;
    }
    await tx.store.put({ ...scope, ...value, revision, key, estimatedBytes, updatedAt: Date.now() });
    await tx.done; return true;
  } finally { db.close(); }
}
export async function clearPreparedCandidates(userId: string) {
  const db = await dbPromise();
  try {
    const tx = db.transaction('candidates', 'readwrite');
    for (const key of await tx.store.index('byUser').getAllKeys(userId)) await tx.store.delete(key);
    await tx.done;
  } finally { db.close(); }
}
