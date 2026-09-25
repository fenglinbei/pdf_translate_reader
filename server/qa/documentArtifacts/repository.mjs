import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { ArtifactError, artifactAssert } from '../../../shared/qaDocumentArtifact.mjs';
import { DOCUMENT_BUILDER_VERSION, DOCUMENT_MAPPING_VERSION, sha256Text } from '../../../shared/qaDocumentBuilder.mjs';
import { createArtifactLoader } from './loader.mjs';
import { createPreparationPool, validateCandidateInWorker } from './preparationPool.mjs';
import { ARTIFACT_BUCKET, assertParserStoragePaths, createArtifactServiceClient, readStorageObject, publishedPrefix, candidatePath, uploadImmutableText } from './storage.mjs';

const required = (condition, code, message, statusCode = 409) => {
  if (!condition) throw Object.assign(new ArtifactError(code, message), { statusCode });
};
const result = (response, code = 'ARTIFACT_DATABASE_UNAVAILABLE') => {
  if (response.error) throw Object.assign(new ArtifactError(code, '文档准备服务暂时不可用。'), { statusCode: 503 });
  return response.data;
};
const pool = createPreparationPool();
const inflightPublications = new Map();

export async function checkArtifactSchema(client = createArtifactServiceClient()) {
  const check = await client.from('user_qa_document_artifacts').select('revision,manifest_path,pdf_path').limit(0);
  if (check.error) throw new Error('Apply supabase/migrations/20260925_qa_document_artifacts.sql to the isolated QA database first.');
  if (process.env.QA_AGENT_RUNTIME === 'workspace-artifacts-v1') {
    const probe = await client.rpc('qa_commit_artifact_answer', { p_user_id: null, p_message_id: null, p_content: '', p_snapshot: {}, p_usage: null, p_citations: [] });
    if (probe.error?.message !== 'message_not_available') throw new Error('Apply supabase/migrations/20260925_qa_artifact_answers.sql to the isolated QA database first.');
  }
}
export async function requireArtifactDocument({ userId, documentId }, client = createArtifactServiceClient()) {
  const document = result(await client.from('user_documents')
    .select('id,user_id,content_sha256,pdf_fingerprint,storage_path,file_size,display_file_name,title')
    .eq('id', documentId).eq('user_id', userId).is('deleted_at', null).maybeSingle());
  required(document, 'DOCUMENT_NOT_FOUND', '未找到这篇文档，或文档已删除。', 404);
  return document;
}
export async function inspectArtifactSource(scope, client = createArtifactServiceClient()) {
  const document = await requireArtifactDocument(scope, client);
  const parsed = result(await client.from('user_mathpix_documents')
    .select('content_sha256,mathpix_options_hash,status,pages_storage_path,full_mmd_storage_path,updated_at,num_pages')
    .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).eq('content_sha256', document.content_sha256)
    .is('deleted_at', null).order('updated_at', { ascending: false }).limit(1).maybeSingle());
  const readable = parsed?.status === 'completed' && parsed.pages_storage_path && parsed.full_mmd_storage_path;
  // These database fields are writable by the owner. A service-role download
  // must not trust a path that could name another user's private object.
  if (readable) assertParserStoragePaths(scope.userId, document, parsed);
  const sourceToken = readable ? await sha256Text(JSON.stringify([document.content_sha256, document.storage_path,
    parsed.mathpix_options_hash, parsed.updated_at, parsed.pages_storage_path, parsed.full_mmd_storage_path,
    DOCUMENT_BUILDER_VERSION, DOCUMENT_MAPPING_VERSION])) : undefined;
  return { document, parsed, readable: Boolean(readable), sourceToken };
}
async function preparation(scope, client) {
  return result(await client.from('user_qa_document_preparations').select('*')
    .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).maybeSingle());
}
async function artifactRecord(scope, revision, client) {
  return result(await client.from('user_qa_document_artifacts').select('*')
    .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).eq('revision', revision).maybeSingle());
}
function publicArtifact(record) {
  return { revision: record.revision, manifestSha256: record.manifest_sha256, pdfSha256: record.pdf_sha256,
    manifestPath: record.manifest_path, pdfPath: record.pdf_path, pageCount: record.page_count, bucket: ARTIFACT_BUCKET };
}
export async function getArtifactState(scope, client = createArtifactServiceClient()) {
  const source = await inspectArtifactSource(scope, client);
  if (!source.readable) return { state: 'unavailable', reason: '需要已有 MathPix 解析的完整正文与版面数据。' };
  const prep = await preparation(scope, client);
  if (prep?.source_token === source.sourceToken && prep.state === 'ready') {
    const record = await artifactRecord(scope, prep.revision, client);
    if (record) return { state: 'ready', ...publicArtifact(record) };
  }
  if (prep?.source_token === source.sourceToken && ['building','validating'].includes(prep.state)
    && Date.parse(prep.lease_expires_at) > Date.now()) return { state: 'preparing', retryAfterSeconds: 3 };
  return { state: 'missing' };
}
export async function beginArtifactPreparation(scope, client = createArtifactServiceClient()) {
  const source = await inspectArtifactSource(scope, client);
  required(source.readable, 'DOCUMENT_NOT_READY', '请先同步这篇文档已有的 MathPix 完整正文与版面数据。');
  const previous = await preparation(scope, client);
  if (previous?.source_token === source.sourceToken && previous.state === 'ready') {
    const record = await artifactRecord(scope, previous.revision, client);
    if (record) return { state: 'ready', ...publicArtifact(record) };
  }
  const leaseToken = randomUUID();
  const claimed = result(await client.rpc('qa_claim_document_preparation', { p_user_id: scope.userId,
    p_document_id: scope.documentId, p_source_token: source.sourceToken, p_lease_token: leaseToken }));
  if (!claimed) return { state: 'preparing', retryAfterSeconds: 3 };
  // Retire only the superseded, unpublished candidate for this document. No
  // source PDF, parser cache or published historical version is deleted here.
  if (previous?.lease_token) await client.storage.from(ARTIFACT_BUCKET).remove([candidatePath({ ...scope, leaseToken: previous.lease_token })]);
  return { state: 'claimed', leaseToken, sourceToken: source.sourceToken,
    candidatePath: candidatePath({ ...scope, leaseToken }), bucket: ARTIFACT_BUCKET,
    input: { pdfSha256: source.document.content_sha256.replace(/^sha256-/, ''), pageCount: source.parsed.num_pages ?? undefined,
      bucket: 'user-mathpix', pagesPath: source.parsed.pages_storage_path, mmdPath: source.parsed.full_mmd_storage_path } };
}

async function concurrentEach(items, count, fn) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length || failure) return;
      try { await fn(items[index]); } catch (error) { failure ??= error; return; }
    }
  }));
  if (failure) throw failure;
}
async function commitPublication(client, scope, leaseToken, source, record) {
  const published = result(await client.rpc('qa_publish_document_artifact', { p_user_id: scope.userId, p_document_id: scope.documentId,
    p_lease_token: leaseToken, p_source_token: source.sourceToken, p_revision: record.revision, p_manifest_sha256: record.manifest_sha256,
    p_pdf_sha256: record.pdf_sha256, p_total_bytes: record.total_bytes, p_page_count: record.page_count,
    p_parse_updated_at: source.parsed.updated_at, p_mathpix_options_hash: source.parsed.mathpix_options_hash,
    p_pages_path: source.parsed.pages_storage_path, p_mmd_path: source.parsed.full_mmd_storage_path }));
  required(published, 'DOCUMENT_VERSION_CHANGED', '文档在准备过程中已更新，请重新准备。');
  return { state: 'ready', ...publicArtifact(await artifactRecord(scope, record.revision, client)) };
}
export async function publishArtifactCandidate(scope, leaseToken, { fallback = false } = {}) {
  required(typeof leaseToken === 'string' && /^[0-9a-f-]{36}$/.test(leaseToken), 'INVALID_PREPARATION_LEASE', '无效的文档准备租约。', 400);
  const key = JSON.stringify([scope.userId, scope.documentId, leaseToken]);
  if (inflightPublications.has(key)) return inflightPublications.get(key);
  const work = pool.submit(async deadline => {
    const controller = new AbortController(), signal = AbortSignal.any([deadline, controller.signal]);
    const client = createArtifactServiceClient(signal);
    const source = await inspectArtifactSource(scope, client), prep = await preparation(scope, client);
    required(source.readable && prep?.lease_token === leaseToken && prep.source_token === source.sourceToken
      && Date.parse(prep.lease_expires_at) > Date.now(), 'PREPARATION_LEASE_CHANGED', '文档版本或准备租约已变化，请重新准备。');
    if (prep.state === 'ready') {
      const existing = await artifactRecord(scope, prep.revision, client);
      required(existing, 'ARTIFACT_NOT_FOUND', '文档产物尚未就绪。'); return { state: 'ready', ...publicArtifact(existing) };
    }
    const admitted = result(await client.from('user_qa_document_preparations').update({ state: 'validating', updated_at: new Date().toISOString() })
      .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).eq('lease_token', leaseToken).eq('state','building').select('lease_token').maybeSingle());
    required(admitted, 'PREPARATION_IN_PROGRESS', '文档正在准备，请稍后重试。');
    const candidate = candidatePath({ ...scope, leaseToken });
    let uploadPrefix, uploadRevision, uploadedPaths = [];
    try {
      const [mmd, pages, supplied] = await Promise.all([
        readStorageObject(client, 'user-mathpix', source.parsed.full_mmd_storage_path, 8 * 1024 * 1024, { signal }),
        readStorageObject(client, 'user-mathpix', source.parsed.pages_storage_path, 32 * 1024 * 1024, { signal }),
        fallback ? undefined : readStorageObject(client, ARTIFACT_BUCKET, candidate, 32 * 1024 * 1024, { signal }),
      ]);
      const input = { pdfSha256: source.document.content_sha256.replace(/^sha256-/, ''), mmd: mmd.text,
        pagesText: pages.text, ...(source.parsed.num_pages ? { pageCount: source.parsed.num_pages } : {}) };
      const { result: packed } = await validateCandidateInWorker(input, supplied?.text, { signal });
      const { manifest } = packed, prefix = publishedPrefix({ ...scope, revision: manifest.revision, leaseToken });
      const existing = await artifactRecord(scope, manifest.revision, client);
      // Device cache timestamps and an equivalent reparse may change the source
      // record token without changing logical/layout content. Reuse the already
      // validated immutable revision; never overwrite its archived raw assets.
      if (existing) return await commitPublication(client, scope, leaseToken, source, existing);
      uploadPrefix = prefix; uploadRevision = manifest.revision;
      uploadedPaths = [...packed.files.map(file => prefix + file.id + '.json'), ...['source.mmd','source-pages.json','manifest.json','source.pdf'].map(file => prefix + file)];
      // Publication is the final database transaction. Incomplete uploads have
      // no manifest row and cannot be read through the authenticated policy.
      await concurrentEach(packed.files, 4, file => uploadImmutableText(client, prefix + file.id + '.json', file.text, 'application/json', signal));
      await uploadImmutableText(client, prefix + 'source.mmd', mmd.text, 'text/plain', signal);
      await uploadImmutableText(client, prefix + 'source-pages.json', pages.text, 'application/json', signal);
      await uploadImmutableText(client, prefix + 'manifest.json', packed.manifestText, 'application/json', signal);
      const copied = await client.storage.from('user-pdfs').copy(source.document.storage_path, prefix + 'source.pdf', { destinationBucket: ARTIFACT_BUCKET });
      if (copied.error && !/already exists/i.test(copied.error.message ?? '') && String(copied.error.statusCode) !== '409') {
        throw new ArtifactError('ARTIFACT_PDF_UNAVAILABLE', '无法保留这篇文档的 PDF 版本。');
      }
      // Hash the immutable archived bytes, not a mutable source before copy.
      const pdf = await readStorageObject(client, ARTIFACT_BUCKET, prefix + 'source.pdf', 100 * 1024 * 1024, { signal, hashOnly: true });
      artifactAssert(pdf.sha256 === manifest.source.pdfSha256, 'PDF_SOURCE_MISMATCH', 'The retained PDF does not match the document source identity.');
      return await commitPublication(client, scope, leaseToken, source, { revision: manifest.revision, manifest_sha256: packed.manifestSha256,
        pdf_sha256: manifest.source.pdfSha256, total_bytes: manifest.totalBytes + Buffer.byteLength(packed.manifestText) + mmd.bytes + pages.bytes + pdf.bytes,
        page_count: manifest.pageCount });
    } catch (error) {
      controller.abort(error);
      const cleanupClient = createArtifactServiceClient();
      await cleanupClient.from('user_qa_document_preparations').update({ state: 'failed', error_code: error.code ?? 'PREPARATION_FAILED', updated_at: new Date().toISOString() })
        .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).eq('lease_token', leaseToken).neq('state','ready');
      if (uploadPrefix) {
        try {
          const published = await artifactRecord(scope, uploadRevision, cleanupClient);
          // Each attempt has its own namespace. Never remove a committed prefix,
          // including a successful commit whose response was lost in transit.
          if (published?.manifest_path !== uploadPrefix + 'manifest.json') {
            for (let i = 0; i < uploadedPaths.length; i += 100) await cleanupClient.storage.from(ARTIFACT_BUCKET).remove(uploadedPaths.slice(i, i + 100));
          }
        } catch { /* Database uncertainty retains bytes for later reconciliation. */ }
      }
      throw error;
    } finally {
      await createArtifactServiceClient().storage.from(ARTIFACT_BUCKET).remove([candidate]);
    }
  });
  inflightPublications.set(key, work);
  try { return await work; } finally { inflightPublications.delete(key); }
}

export async function getPublishedArtifact(scope, revision, client = createArtifactServiceClient()) {
  await requireArtifactDocument(scope, client);
  const record = await artifactRecord(scope, revision, client);
  required(record, 'ARTIFACT_NOT_FOUND', '未找到这次引用的文档版本。', 404);
  return publicArtifact(record);
}
export async function cancelArtifactPreparation(scope, leaseToken, client = createArtifactServiceClient()) {
  await requireArtifactDocument(scope, client);
  const stopped = result(await client.from('user_qa_document_preparations').update({ state: 'failed', error_code: 'PREPARATION_CANCELLED' })
    .eq('user_id', scope.userId).eq('user_document_id', scope.documentId).eq('lease_token', leaseToken).eq('state','building').select('lease_token').maybeSingle());
  if (stopped) await client.storage.from(ARTIFACT_BUCKET).remove([candidatePath({ ...scope, leaseToken })]);
  return { cancelled: Boolean(stopped) };
}
const loader = createArtifactLoader({
  authorize: scope => requireArtifactDocument(scope),
  loadText: async (scope, maxBytes) => {
    const client = createArtifactServiceClient();
    const path = scope.storagePrefix + (scope.partId === 'manifest' ? 'manifest.json' : scope.partId + '.json');
    return (await readStorageObject(client, ARTIFACT_BUCKET, path, maxBytes)).text;
  },
});
export async function openCurrentArtifact(scope, { signal, allowFallback = true } = {}) {
  let state = await getArtifactState(scope);
  if (state.state === 'missing' && allowFallback) {
    const claim = await beginArtifactPreparation(scope);
    state = claim.state === 'claimed' ? await publishArtifactCandidate(scope, claim.leaseToken, { fallback: true }) : claim;
  }
  const waitUntil = Date.now() + 120000;
  while (state.state === 'preparing' && Date.now() < waitUntil) {
    await delay(3000, undefined, { signal }); state = await getArtifactState(scope);
  }
  required(state.state === 'ready', state.state === 'preparing' ? 'DOCUMENT_PREPARING' : 'DOCUMENT_NOT_READY',
    state.state === 'preparing' ? '这篇文档正在准备，请稍后继续。' : '需要先同步这篇文档已有的 MathPix 完整解析。');
  return loader.open({ ...scope, revision: state.revision, manifestSha256: state.manifestSha256,
    storagePrefix: state.manifestPath.replace(/manifest\.json$/, '') }, { signal });
}
export const artifactMetrics = () => ({ preparation: pool.metrics, cache: loader.metrics });
