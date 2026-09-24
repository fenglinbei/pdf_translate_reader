-- Additive P2 migration: apply to the isolated QA database before enabling
-- document-tools-v1. Existing indexed_chunk citations remain readable.
begin;
alter table public.user_qa_citations
  alter column chunk_id drop not null,
  add column if not exists source_kind text not null default 'indexed_chunk',
  add column if not exists source_version text,
  add column if not exists evidence_key text,
  add column if not exists source_record_id text,
  add column if not exists source_locator jsonb;
alter table public.user_qa_citations drop constraint if exists user_qa_citations_source_check;
alter table public.user_qa_citations add constraint user_qa_citations_source_check check (coalesce((
  (source_kind = 'indexed_chunk' and chunk_id is not null)
  or (source_kind = 'document_text' and chunk_id is null
    and source_version is not null and length(source_version) > 0
    and evidence_key is not null and length(evidence_key) > 0
    and source_record_id is not null and length(source_record_id) > 0
    and source_locator is not null and jsonb_typeof(source_locator) = 'object'
    and source_locator->>'version' = 'citation-locator-v1'
    and jsonb_typeof(source_locator->'sourceSpans') = 'array'
    and jsonb_array_length(source_locator->'sourceSpans') > 0
    and source_locator->>'sourceUpdatedAt' is not null)
), false));

drop policy if exists "Users can manage their QA citations" on public.user_qa_citations;
create policy "Users can manage their QA citations" on public.user_qa_citations
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.user_qa_messages m join public.user_qa_threads t on t.id = m.thread_id
      where m.id = user_qa_citations.message_id and m.user_id = auth.uid() and m.deleted_at is null
        and t.user_id = auth.uid() and t.active_user_document_id = user_qa_citations.user_document_id and t.deleted_at is null)
    and exists (select 1 from public.user_documents d where d.id = user_qa_citations.user_document_id
      and d.user_id = auth.uid() and d.deleted_at is null)
    and (
      (source_kind = 'indexed_chunk' and exists (select 1 from public.user_paper_chunks c
        where c.id = chunk_id and c.user_id = auth.uid() and c.user_document_id = user_qa_citations.user_document_id))
      or (source_kind = 'document_text' and exists (
        select 1 from public.user_mathpix_documents p join public.user_documents d on d.id = p.user_document_id
        where p.user_id = auth.uid() and p.user_document_id = user_qa_citations.user_document_id
          and p.content_sha256 = d.content_sha256 and p.deleted_at is null and p.status = 'completed'
          and p.content_sha256 || ':' || p.mathpix_options_hash = source_record_id
          and p.updated_at = (source_locator->>'sourceUpdatedAt')::timestamptz))
    )
  );
alter table public.user_qa_agent_steps drop constraint if exists user_qa_agent_steps_tool_name_check;
alter table public.user_qa_agent_steps add constraint user_qa_agent_steps_tool_name_check check (
  tool_name is null or tool_name in ('search_current_paper','open_chunk','verify_citation','compose_answer',
    'get_document_outline','search_document_text','read_document','finish_reading','unknown_tool')
);
alter table public.user_qa_tool_calls drop constraint if exists user_qa_tool_calls_tool_name_check;
alter table public.user_qa_tool_calls add constraint user_qa_tool_calls_tool_name_check check (
  tool_name in ('search_current_paper','open_chunk','verify_citation','compose_answer',
    'get_document_outline','search_document_text','read_document','finish_reading','unknown_tool')
);
alter table public.user_qa_api_logs drop constraint if exists user_qa_api_logs_request_kind_check;
alter table public.user_qa_api_logs add constraint user_qa_api_logs_request_kind_check check (
  request_kind in ('index-job','answer-stream','retrieval','rerank','citation-verification','model-call')
);
notify pgrst, 'reload schema';
commit;
