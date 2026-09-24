-- Additive, safe to apply before the workspace UI release. No history rewrite.
begin;
alter table public.user_qa_threads add column if not exists pinned_at timestamptz;
create index if not exists user_qa_threads_workspace_navigation_idx
  on public.user_qa_threads (user_id, scope, pinned_at desc nulls last, updated_at desc, id desc)
  where deleted_at is null;
notify pgrst, 'reload schema';
commit;
