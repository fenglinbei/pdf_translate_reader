import { requireSupabaseServiceClient } from '../../supabase/service.mjs';

export async function checkQaDocumentSchema(client = requireSupabaseServiceClient()) {
  const { error } = await client.from('user_qa_citations')
    .select('source_kind,source_version,evidence_key,source_record_id,source_locator').limit(0);
  if (error) throw new Error('QA database migration is required: apply supabase/migrations/20260924_qa_document_tools.sql to the isolated QA database before starting this release.');
}
