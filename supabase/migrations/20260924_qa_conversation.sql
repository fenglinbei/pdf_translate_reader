-- Additive QA conversation support. Apply to the isolated QA database first.
begin;

alter table public.user_qa_agent_steps drop constraint if exists user_qa_agent_steps_kind_check;
alter table public.user_qa_agent_steps add constraint user_qa_agent_steps_kind_check check (
  kind in ('plan', 'commentary', 'tool_call', 'observation', 'gap_check', 'answer_outline', 'fallback')
);

commit;
