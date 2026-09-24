-- Additive QA conversation support. Apply to the isolated QA database first.
begin;

alter table public.user_qa_threads drop constraint if exists user_qa_threads_scope_check;
alter table public.user_qa_threads add constraint user_qa_threads_scope_check check (
  scope in ('current', 'current-plus-references', 'library', 'general')
);
alter table public.user_qa_threads drop constraint if exists user_qa_threads_general_context_check;
alter table public.user_qa_threads add constraint user_qa_threads_general_context_check check (
  scope <> 'general' or (active_user_document_id is null and cardinality(reference_document_ids) = 0)
);

alter table public.user_qa_agent_steps drop constraint if exists user_qa_agent_steps_kind_check;
alter table public.user_qa_agent_steps add constraint user_qa_agent_steps_kind_check check (
  kind in ('plan', 'commentary', 'tool_call', 'observation', 'gap_check', 'answer_outline', 'fallback')
);

commit;
