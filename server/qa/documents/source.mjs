import { requireUserDocument } from '../../supabase/qa.mjs';
import { requireSupabaseServiceClient } from '../../supabase/service.mjs';
import { createDocumentView, DOCUMENT_VIEW_VERSION, hash } from './view.mjs';
import { DocumentToolError, requireCondition } from './errors.mjs';

async function inspectSource({ userId, userDocumentId }, client, requireDocument = requireUserDocument) {
  const document = await requireDocument({ userId, userDocumentId });
  const { data, error } = await client.from('user_mathpix_documents')
    .select('content_sha256,mathpix_options_hash,status,pages_storage_path,updated_at,num_pages')
    .eq('user_id', userId).eq('user_document_id', userDocumentId).eq('content_sha256', document.content_sha256)
    .is('deleted_at', null).order('updated_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new DocumentToolError('DOCUMENT_SOURCE_UNAVAILABLE', '无法读取文档解析状态。', { retryable: false, statusCode: 503 });
  return { document, record: data };
}
function sourceVersion(document, record) {
  return hash([document.content_sha256, record.mathpix_options_hash, record.updated_at, record.pages_storage_path, DOCUMENT_VIEW_VERSION]);
}
export async function getDocumentReadiness(scope) {
  const { document, record } = await inspectSource(scope, requireSupabaseServiceClient());
  const state = record?.status === 'completed' && record.pages_storage_path ? 'readable'
    : record?.status === 'error' || record?.status === 'failed' ? 'error' : record ? 'parsing' : 'missing';
  return { state, documentVersion: state === 'readable' ? sourceVersion(document, record) : undefined,
    documentId: scope.userDocumentId, runtime: process.env.QA_AGENT_RUNTIME ?? 'legacy-json-v1' };
}
export async function loadDocumentSource(scope, { signal, client = requireSupabaseServiceClient(), requireDocument = requireUserDocument } = {}) {
  signal?.throwIfAborted();
  const { document, record } = await inspectSource(scope, client, requireDocument);
  requireCondition(record?.status === 'completed' && record.pages_storage_path, 'DOCUMENT_NOT_READY', '请先完成这篇文档的 MathPix 解析。', { retryable: false, statusCode: 409 });
  const version = sourceVersion(document, record);
  const { data, error } = await client.storage.from('user-mathpix').download(record.pages_storage_path);
  if (error || !data) throw new DocumentToolError('DOCUMENT_SOURCE_UNAVAILABLE', '无法读取文档解析产物。', { retryable: false, statusCode: 503 });
  requireCondition(data.size <= 32 * 1024 * 1024, 'DOCUMENT_TOO_LARGE', '解析产物超过当前阅读上限。', { retryable: false, statusCode: 413 });
  let pages;
  try { pages = JSON.parse(await data.text()); } catch { throw new DocumentToolError('DOCUMENT_UNREADABLE', '文档解析产物格式无效。', { retryable: false, statusCode: 409 }); }
  signal?.throwIfAborted();
  const view = createDocumentView({ pages, documentId: scope.userDocumentId, documentVersion: version,
    title: document.display_file_name || '当前文档', pdfFingerprint: document.pdf_fingerprint,
    pageCount: record.num_pages, sourceRecordId: `${record.content_sha256}:${record.mathpix_options_hash}` });
  view.sourceUpdatedAt = record.updated_at;
  async function assertCurrent() {
    signal?.throwIfAborted();
    const current = await inspectSource(scope, client, requireDocument);
    requireCondition(current.record?.status === 'completed' && sourceVersion(current.document, current.record) === version,
      'DOCUMENT_VERSION_CHANGED', '文档或解析版本已变化，请重新提问。', { retryable: false, statusCode: 409 });
  }
  await assertCurrent();
  return { view, assertCurrent };
}

// Permission/metadata are checked up front; parsing artifacts are downloaded
// only when a reading tool is actually used. The view identity stays stable for
// the evidence store, and a changed version never replaces already read text.
export async function createDeferredDocumentSource(scope, { signal, client = requireSupabaseServiceClient(), requireDocument = requireUserDocument } = {}) {
  signal?.throwIfAborted();
  const { document, record } = await inspectSource(scope, client, requireDocument);
  const readable = record?.status === 'completed' && Boolean(record.pages_storage_path);
  const version = readable ? sourceVersion(document, record) : undefined;
  const view = { title: document.display_file_name || '当前文档', pageCount: record?.num_pages ?? 0,
    documentVersion: version, readable };
  let loaded;
  return {
    view,
    async assertCurrent() {
      signal?.throwIfAborted();
      if (loaded) return loaded.assertCurrent();
      const current = await inspectSource(scope, client, requireDocument);
      requireCondition(current.document.content_sha256 === document.content_sha256
        && (!version || current.record?.status === 'completed' && sourceVersion(current.document, current.record) === version),
      'DOCUMENT_VERSION_CHANGED', '文档或解析版本已变化，请重新提问。', { retryable: false, statusCode: 409 });
    },
    async ensureLoaded() {
      if (loaded) return;
      requireCondition(readable, 'DOCUMENT_NOT_READY', '文档尚未完成解析。不要重复读取：普通问题用 finish_reading direct；文档问题用 insufficient 和空引用，提示先完成 MathPix 解析。', { retryable: true, statusCode: 409 });
      const candidate = await loadDocumentSource(scope, { signal, client, requireDocument });
      requireCondition(candidate.view.documentVersion === version, 'DOCUMENT_VERSION_CHANGED', '文档解析版本已变化，请重新提问。', { retryable: false, statusCode: 409 });
      Object.assign(view, candidate.view);
      loaded = candidate;
    },
  };
}
