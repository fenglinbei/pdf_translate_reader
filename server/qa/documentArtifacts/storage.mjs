import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { getSupabaseRuntimeConfig } from '../../supabase/config.mjs';
import { ArtifactError, artifactAssert } from '../../../shared/qaDocumentArtifact.mjs';

export const ARTIFACT_BUCKET = 'qa-document-artifacts';
export function assertParserStoragePaths(userId, document, parsed) {
  artifactAssert(/^[0-9a-f-]{36}$/.test(userId) && /^sha256-[0-9a-f]{64}$/.test(document.content_sha256)
    && document.storage_path === `${userId}/${document.content_sha256}.pdf`
    && /^[a-z0-9-]{1,120}$/.test(parsed.mathpix_options_hash), 'INVALID_SOURCE_STORAGE_SCOPE', 'The document source is outside its owner storage namespace.');
  const prefix = `${userId}/${document.content_sha256}/${parsed.mathpix_options_hash}/`;
  artifactAssert(parsed.content_sha256 === document.content_sha256 && parsed.pages_storage_path === prefix + 'pages.json'
    && parsed.full_mmd_storage_path === prefix + 'full.mmd', 'INVALID_SOURCE_STORAGE_SCOPE', 'The parser inputs do not belong to this document source.');
}
export function createArtifactServiceClient(signal) {
  const config = getSupabaseRuntimeConfig();
  artifactAssert(config.url && config.serviceRoleKey, 'ARTIFACT_STORAGE_UNAVAILABLE', 'QA artifact storage is not configured.');
  return createClient(config.url, config.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.any([
      AbortSignal.timeout(30000), ...(signal ? [signal] : []), ...(init.signal ? [init.signal] : []),
    ]) }) } });
}
const storageError = () => new ArtifactError('ARTIFACT_STORAGE_UNAVAILABLE', '暂时无法读取文档产物。');
export async function readStorageObject(client, bucket, path, maxBytes, { signal, hashOnly = false } = {}) {
  const signed = await client.storage.from(bucket).createSignedUrl(path, 120);
  if (signed.error || !signed.data?.signedUrl) throw storageError();
  const response = await fetch(signed.data.signedUrl, { signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]) });
  if (!response.ok || !response.body) throw storageError();
  const reader = response.body.getReader(), chunks = [], hash = createHash('sha256');
  let bytes = 0;
  try {
    const declared = Number(response.headers.get('content-length'));
    artifactAssert(!declared || declared <= maxBytes, 'ARTIFACT_INPUT_LIMIT', 'Document source exceeds its transfer limit.');
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      artifactAssert(bytes <= maxBytes, 'ARTIFACT_INPUT_LIMIT', 'Document source exceeds its transfer limit.');
      hash.update(value); if (!hashOnly) chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return { bytes, sha256: hash.digest('hex'), ...(hashOnly ? {} : { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) }) };
}
export const publishedPrefix = ({ userId, documentId, revision, leaseToken }) => `published/${userId}/${documentId}/${revision}/${leaseToken ? leaseToken + '/' : ''}`;
export const candidatePath = ({ userId, documentId, leaseToken }) => `candidates/${userId}/${documentId}/${leaseToken}/artifact.json`;
export async function uploadImmutableText(client, path, text, contentType = 'application/json', signal) {
  const { error } = await client.storage.from(ARTIFACT_BUCKET).upload(path, text, { contentType, upsert: false, cacheControl: '0' });
  if (!error) return;
  if (!['409', 'Duplicate'].includes(String(error.statusCode)) && !/already exists/i.test(error.message ?? '')) throw storageError();
  const actual = await readStorageObject(client, ARTIFACT_BUCKET, path, Buffer.byteLength(text), { signal });
  artifactAssert(actual.sha256 === createHash('sha256').update(text).digest('hex'), 'IMMUTABLE_PART_CONFLICT', 'An immutable document part has conflicting contents.');
}
