import { artifactAssert } from '../../../shared/qaDocumentArtifact.mjs';

function immutableData(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) continue;
    if (typeof item !== 'object' || !Object.isFrozen(item)
      || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    if (seen.has(item)) continue;
    seen.add(item);
    for (const child of Object.values(item)) pending.push(child);
  }
  return true;
}

// Stores immutable, already authorized artifact parts; NEVER stores an access
// decision. A loader must authorize before using this cache on every request.
// estimatedBytes is a resident-size estimate, not a hard JavaScript heap bound.
export function createArtifactPartCache({ maxBytes, maxEntries = 128 }) {
  artifactAssert([maxBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0),
    'INVALID_CACHE_BUDGET', 'Artifact cache budgets must be positive integers.');
  const entries = new Map();
  let bytes = 0, hits = 0, misses = 0, evictions = 0;
  function keyFor(scope) {
    artifactAssert(scope && ['userId', 'documentId', 'partId'].every(key => typeof scope[key] === 'string'
      && scope[key].length > 0 && scope[key].length <= 200)
      && typeof scope.revision === 'string' && /^[a-f0-9]{64}$/.test(scope.revision),
    'INVALID_CACHE_SCOPE', 'Cache identity must include user, document, revision and part.');
    return JSON.stringify([scope.userId, scope.documentId, scope.revision, scope.partId]);
  }
  function remove(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.estimatedBytes; entries.delete(key); }
  }
  return {
    get(scope) {
      const key = keyFor(scope), entry = entries.get(key);
      if (!entry) { misses++; return undefined; }
      hits++; entries.delete(key); entries.set(key, entry); return entry.value;
    },
    set(scope, value, estimatedBytes) {
      const key = keyFor(scope);
      artifactAssert(Number.isSafeInteger(estimatedBytes) && estimatedBytes > 0, 'INVALID_CACHE_SIZE', 'Cache values need an explicit size estimate.');
      artifactAssert((typeof value === 'string' || value !== null && typeof value === 'object') && immutableData(value),
        'MUTABLE_CACHE_VALUE', 'Only immutable artifact values may be shared between runs.');
      if (estimatedBytes > maxBytes) return false;
      remove(key);
      while (entries.size >= maxEntries || bytes + estimatedBytes > maxBytes) {
        remove(entries.keys().next().value); evictions++;
      }
      entries.set(key, { value, estimatedBytes, userId: scope.userId }); bytes += estimatedBytes; return true;
    },
    clearUser(userId) {
      for (const [key, entry] of entries) if (entry.userId === userId) remove(key);
    },
    clear() { entries.clear(); bytes = 0; },
    get metrics() { return { entries: entries.size, estimatedBytes: bytes, hits, misses, evictions }; },
  };
}
