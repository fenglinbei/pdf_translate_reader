import { requireSupabaseServiceClient } from '../../supabase/service.mjs';
import { DocumentToolError } from '../documents/errors.mjs';

export async function checkWorkspaceSchema(client = requireSupabaseServiceClient()) {
  const { error } = await client.from('user_qa_threads').select('origin_scope,origin_user_document_id,workspace_upgraded_at').limit(0);
  if (error) throw new Error('Apply supabase/migrations/20260925_qa_workspace.sql to the isolated QA database first.');
}

export async function getWorkspaceTrace({ userId, messageId }, client = requireSupabaseServiceClient()) {
  const { data: message, error } = await client.from('user_qa_messages').select('thread_id,prompt_version')
    .eq('id', messageId).eq('user_id', userId).is('deleted_at', null).maybeSingle();
  if (error) throw new DocumentToolError('TRACE_UNAVAILABLE', '暂时无法读取运行记录。', { statusCode: 503 });
  if (!message) throw new DocumentToolError('MESSAGE_NOT_FOUND', '未找到消息。', { statusCode: 404 });
  const thread = await client.from('user_qa_threads').select('id').eq('id', message.thread_id).eq('user_id', userId).is('deleted_at', null).maybeSingle();
  if (thread.error || !thread.data) throw new DocumentToolError('MESSAGE_NOT_FOUND', '未找到会话。', { statusCode: 404 });
  const logs = await client.from('user_qa_api_logs').select('request_kind,request_started_at,request_finished_at,status,usage,payload')
    .eq('user_id', userId).eq('message_id', messageId).is('deleted_at', null).order('request_started_at');
  if (logs.error) throw new DocumentToolError('TRACE_UNAVAILABLE', '暂时无法读取运行记录。', { statusCode: 503 });
  return { version: 'qa-public-trace-v1', promptVersion: message.prompt_version,
    privateContinuation: 'not_stored_not_byte_exact_replay', records: logs.data };
}

// PostgREST quoted filter values: escape both LIKE wildcards and grammar quotes.
// User identity and pagination are always supplied by the harness, never the model.
export function metadataFilter(query) {
  const term = query.replace(/[\\%_]/g, '\\$&').replace(/"/g, '\\"');
  return ['title', 'display_file_name', 'abstract'].map(field => `${field}.ilike."%${term}%"`).join(',');
}
export async function discoverWorkspaceDocuments({ userId, query = '', offset = 0, limit = 10, archived = 'all', currentDocumentId }, client = requireSupabaseServiceClient()) {
  const columns = 'id,content_sha256,title,display_file_name,authors,abstract,publication_year,archived_at';
  const base = () => client.from('user_documents').select(columns).eq('user_id', userId).is('deleted_at', null);
  let request = base();
  if (query.trim()) request = request.or(metadataFilter(query.trim()));
  if (archived === 'only') request = request.not('archived_at', 'is', null);
  if (archived === 'exclude') request = request.is('archived_at', null);
  const { data, error } = await request.order('last_opened_at', { ascending: false, nullsFirst: false }).order('id').range(offset, offset + limit);
  if (error) throw new DocumentToolError('DISCOVERY_UNAVAILABLE', '暂时无法读取文库，请稍后重试。', { retryable: false });
  const rows = (data ?? []).slice(0, limit);
  let current = rows.find(row => row.id === currentDocumentId);
  if (!current && currentDocumentId) {
    const result = await base().eq('id', currentDocumentId).maybeSingle();
    if (result.error) throw new DocumentToolError('DISCOVERY_UNAVAILABLE', '暂时无法读取当前文档信息。', { retryable: false });
    current = result.data;
  }
  const ids = [...new Set([...rows, ...(current ? [current] : [])].map(row => row.id))];
  const readiness = ids.length ? await client.from('user_mathpix_documents').select('user_document_id,status,pages_storage_path,content_sha256,updated_at')
    .eq('user_id', userId).in('user_document_id', ids).is('deleted_at', null).order('updated_at', { ascending: false }) : { data: [] };
  if (readiness.error) throw new DocumentToolError('DISCOVERY_UNAVAILABLE', '暂时无法读取文档可读状态。', { retryable: false });
  const convert = row => {
    const parsed = readiness.data?.find(record => record.user_document_id === row.id && record.content_sha256 === row.content_sha256);
    const abstract = row.abstract?.trim();
    return { id: row.id, title: (row.title || row.display_file_name).slice(0, 240), authors: (row.authors ?? []).slice(0, 6), year: row.publication_year,
      abstract: abstract?.slice(0, 1000) ?? null, abstractSource: abstract ? 'library_metadata_not_citable' : null, abstractTruncated: Boolean(abstract && abstract.length > 1000),
      isCurrent: row.id === currentDocumentId, archived: Boolean(row.archived_at),
      readable: parsed?.status === 'completed' && Boolean(parsed.pages_storage_path) };
  };
  return { documents: rows.map(convert), currentDocument: current ? convert(current) : null,
    hasMore: (data?.length ?? 0) > limit, nextOffset: offset + rows.length };
}
