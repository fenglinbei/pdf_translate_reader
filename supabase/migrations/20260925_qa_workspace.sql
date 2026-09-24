-- Apply only to the isolated QA database before workspace-tools-v1.
begin;
alter table public.user_qa_threads
  add column if not exists origin_scope text,
  add column if not exists origin_user_document_id uuid,
  add column if not exists workspace_upgraded_at timestamptz;
alter table public.user_qa_threads drop constraint if exists user_qa_threads_scope_check;
alter table public.user_qa_threads add constraint user_qa_threads_scope_check check (
  scope in ('current','current-plus-references','library','general','workspace')
);
alter table public.user_qa_threads drop constraint if exists user_qa_threads_workspace_context_check;
alter table public.user_qa_threads add constraint user_qa_threads_workspace_context_check check (
  scope <> 'workspace' or active_user_document_id is null
);
-- In-place and idempotent: message/citation identities and original timestamps survive.
update public.user_qa_threads set origin_scope = scope,
  origin_user_document_id = active_user_document_id, workspace_upgraded_at = now(),
  scope = 'workspace', active_user_document_id = null
where scope <> 'workspace' and workspace_upgraded_at is null;

alter table public.user_qa_agent_steps drop constraint if exists user_qa_agent_steps_tool_name_check;
alter table public.user_qa_agent_steps add constraint user_qa_agent_steps_tool_name_check check (
  tool_name is null or tool_name in ('search_current_paper','open_chunk','verify_citation','compose_answer',
    'get_document_outline','search_document_text','read_document','finish_reading','unknown_tool',
    'discover_documents','document_outline','search_document','cite_sources')
);
alter table public.user_qa_tool_calls drop constraint if exists user_qa_tool_calls_tool_name_check;
alter table public.user_qa_tool_calls add constraint user_qa_tool_calls_tool_name_check check (
  tool_name in ('search_current_paper','open_chunk','verify_citation','compose_answer',
    'get_document_outline','search_document_text','read_document','finish_reading','unknown_tool',
    'discover_documents','document_outline','search_document','cite_sources')
);

drop policy if exists "Users can manage their QA citations" on public.user_qa_citations;
create policy "Users can manage their QA citations" on public.user_qa_citations
  for all using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (select 1 from public.user_qa_messages m join public.user_qa_threads t on t.id = m.thread_id
      where m.id = user_qa_citations.message_id and m.user_id = auth.uid() and m.deleted_at is null
        and t.user_id = auth.uid() and t.deleted_at is null
        and (t.scope = 'workspace' or t.active_user_document_id = user_qa_citations.user_document_id))
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
notify pgrst, 'reload schema';
commit;
