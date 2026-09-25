import { requireSupabaseClient, getSupabaseAccessToken } from '../../auth/supabaseClient';
import { prepareDocumentInWorker } from './preparationClient';
import type { PreparationScope } from './preparationCache';
import type { DocumentBuildInput } from '../../../shared/qaDocumentBuilder.mjs';

export type PublishedArtifact = { state: 'ready'; revision: string; manifestSha256: string; pdfSha256: string;
  manifestPath: string; pdfPath: string; pageCount: number; bucket: string };
type ClaimedPreparation = { state: 'claimed'; leaseToken: string; sourceToken: string; candidatePath: string; bucket: string;
  input: { pdfSha256: string; pageCount?: number; bucket: string; pagesPath: string; mmdPath: string } };
type PreparationState = PublishedArtifact | ClaimedPreparation | { state: 'preparing'; retryAfterSeconds: number }
  | { state: 'unavailable'; reason: string } | { state: 'missing' };
const base = import.meta.env.VITE_API_BASE_URL ?? '/api';
async function assertUser(userId: string) {
  const { data } = await requireSupabaseClient().auth.getSession();
  if (data.session?.user.id !== userId) throw new DOMException('Account changed.', 'AbortError');
}
async function request(documentId: string, suffix = '', options: RequestInit = {}) {
  const response = await fetch(`${base}/qa/documents/${encodeURIComponent(documentId)}/artifact${suffix}`, {
    ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await getSupabaseAccessToken()}`, ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? 'Document preparation failed.'), { code: data?.error?.code });
  return data as PreparationState;
}
export async function getPublishedDocumentArtifact(documentId: string, revision: string, signal?: AbortSignal) {
  return request(documentId, `?revision=${encodeURIComponent(revision)}`, { signal }) as Promise<PublishedArtifact>;
}
async function readObject(bucket: string, path: string, maxBytes: number, signal?: AbortSignal) {
  const token = await getSupabaseAccessToken();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}?access=${crypto.randomUUID()}`;
  const response = await fetch(url, { signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY } });
  if (!response.ok || !response.body) throw new Error('Could not load the authorized document input.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Document input exceeds the preparation limit.'); chunks.push(value); }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
  return new Blob(chunks).text();
}
const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
export async function ensureClientDocumentPrepared(scope: PreparationScope, signal?: AbortSignal) {
  let lease: ClaimedPreparation | undefined, finished = false;
  try {
    await assertUser(scope.userId);
    let state = await request(scope.documentId, '', { signal });
    const deadline = Date.now() + 150000;
    while (state.state !== 'ready') {
      signal?.throwIfAborted(); await assertUser(scope.userId);
      if (state.state === 'unavailable') return state;
      if (Date.now() >= deadline) return { state: 'preparing' as const, retryAfterSeconds: 3 };
      if (state.state === 'preparing') { await pause(3000, signal); state = await request(scope.documentId, '', { signal }); continue; }
      // Let this short claim return its token even when the view unmounts, so
      // finally can release it instead of abandoning an unknown live lease.
      if (state.state === 'missing') state = await request(scope.documentId, '/prepare', { method: 'POST', signal: AbortSignal.timeout(15000) });
      if (state.state !== 'claimed') continue;
      lease = state;
      const [mmd, pagesText] = await Promise.all([
        readObject(lease.input.bucket, lease.input.mmdPath, 8 * 1024 * 1024, signal),
        readObject(lease.input.bucket, lease.input.pagesPath, 32 * 1024 * 1024, signal),
      ]);
      signal?.throwIfAborted(); await assertUser(scope.userId);
      const input: DocumentBuildInput = { pdfSha256: lease.input.pdfSha256, pageCount: lease.input.pageCount, mmd, pages: JSON.parse(pagesText) };
      const candidate = await prepareDocumentInWorker(scope, input, { signal });
      await assertUser(scope.userId); signal?.throwIfAborted();
      const blob = new Blob([JSON.stringify(candidate.artifact)], { type: 'application/json' });
      if (blob.size > 32 * 1024 * 1024) throw new Error('Document candidate exceeds the publication limit.');
      const uploaded = await requireSupabaseClient().storage.from(lease.bucket).upload(lease.candidatePath, blob, { contentType: 'application/json', upsert: false });
      if (uploaded.error) throw uploaded.error;
      signal?.throwIfAborted(); await assertUser(scope.userId);
      for (;;) {
        try { state = await request(scope.documentId, '/publish', { method: 'POST', body: JSON.stringify({ leaseToken: lease.leaseToken }), signal }); break; }
        catch (error) {
          if ((error as { code?: string })?.code !== 'PREPARATION_BUSY' || Date.now() >= deadline) throw error;
          await pause(3000, signal);
        }
      }
    }
    finished = true;
    return state;
  } finally {
    if (lease && !finished) {
      // Cancelling browser CPU work releases its lease but preserves the local
      // checkpoint. An admitted server publication may finish for other devices.
      await request(scope.documentId, '/prepare', { method: 'DELETE', body: JSON.stringify({ leaseToken: lease.leaseToken }) }).catch(() => {});
    }
  }
}
