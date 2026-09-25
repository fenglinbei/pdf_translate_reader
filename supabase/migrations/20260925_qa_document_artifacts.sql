-- Additive, isolated-QA rollout. Published revisions are immutable and remain
-- readable while their document is active, even after a later parse replaces it.
begin;
create table if not exists public.user_qa_document_artifacts (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  revision text not null check (revision ~ '^[0-9a-f]{64}$'),
  source_token text not null check (source_token ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  pdf_sha256 text not null check (pdf_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_path text not null,
  pdf_path text not null,
  total_bytes bigint not null check (total_bytes > 0 and total_bytes <= 209715200),
  page_count integer not null check (page_count between 1 and 10000),
  created_at timestamptz not null default now(),
  primary key (user_id, user_document_id, revision)
);
create table if not exists public.user_qa_document_preparations (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  source_token text not null check (source_token ~ '^[0-9a-f]{64}$'),
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  state text not null check (state in ('building','validating','ready','failed')),
  revision text check (revision is null or revision ~ '^[0-9a-f]{64}$'),
  error_code text,
  updated_at timestamptz not null default now(),
  primary key (user_id, user_document_id)
);
alter table public.user_qa_document_artifacts enable row level security;
alter table public.user_qa_document_preparations enable row level security;
drop policy if exists "Read active document revisions" on public.user_qa_document_artifacts;
create policy "Read active document revisions" on public.user_qa_document_artifacts for select to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.user_documents d
    where d.id = user_document_id and d.user_id = auth.uid() and d.deleted_at is null));
drop policy if exists "Read own preparation status" on public.user_qa_document_preparations;
create policy "Read own preparation status" on public.user_qa_document_preparations for select to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.user_documents d
    where d.id = user_document_id and d.user_id = auth.uid() and d.deleted_at is null));
revoke all on public.user_qa_document_artifacts, public.user_qa_document_preparations from anon, authenticated;
grant select on public.user_qa_document_artifacts, public.user_qa_document_preparations to authenticated;
grant all on public.user_qa_document_artifacts, public.user_qa_document_preparations to service_role;

create or replace function public.qa_claim_document_preparation(
  p_user_id uuid, p_document_id uuid, p_source_token text, p_lease_token uuid
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare affected integer;
begin
  if not exists (select 1 from user_documents where id = p_document_id and user_id = p_user_id and deleted_at is null)
    then raise exception 'document_not_available'; end if;
  -- One client preparation per user, and one lease per document across devices.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':qa-preparation', 0));
  if exists (select 1 from user_qa_document_preparations where user_id = p_user_id and user_document_id <> p_document_id
    and state in ('building','validating') and lease_expires_at > now()) then return false; end if;
  insert into user_qa_document_preparations(user_id,user_document_id,source_token,lease_token,lease_expires_at,state)
  values (p_user_id,p_document_id,p_source_token,p_lease_token,now() + interval '5 minutes','building')
  on conflict (user_id,user_document_id) do update set source_token = excluded.source_token, lease_token = excluded.lease_token,
    lease_expires_at = excluded.lease_expires_at, state = 'building', revision = null, error_code = null, updated_at = now()
  where user_qa_document_preparations.lease_expires_at <= now()
    or user_qa_document_preparations.source_token <> excluded.source_token
    or user_qa_document_preparations.state in ('ready','failed');
  get diagnostics affected = row_count;
  return affected = 1;
end $$;

create or replace function public.qa_publish_document_artifact(
  p_user_id uuid, p_document_id uuid, p_lease_token uuid, p_source_token text,
  p_revision text, p_manifest_sha256 text, p_pdf_sha256 text, p_total_bytes bigint, p_page_count integer,
  p_parse_updated_at timestamptz, p_mathpix_options_hash text, p_pages_path text, p_mmd_path text
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare prep user_qa_document_preparations; doc user_documents; parsed user_mathpix_documents;
  prefix text := 'published/' || p_user_id::text || '/' || p_document_id::text || '/' || p_revision || '/' || p_lease_token::text || '/';
begin
  select * into prep from user_qa_document_preparations where user_id = p_user_id and user_document_id = p_document_id for update;
  if prep.lease_token is distinct from p_lease_token or prep.source_token is distinct from p_source_token
    or prep.state <> 'validating' or prep.lease_expires_at <= now() then return false; end if;
  select * into doc from user_documents where id = p_document_id and user_id = p_user_id and deleted_at is null for share;
  if not found or doc.content_sha256 <> 'sha256-' || p_pdf_sha256 then return false; end if;
  select * into parsed from user_mathpix_documents where user_id = p_user_id and user_document_id = p_document_id
    and content_sha256 = doc.content_sha256 and deleted_at is null order by updated_at desc limit 1 for share;
  if not found or parsed.status <> 'completed' or parsed.updated_at is distinct from p_parse_updated_at
    or parsed.mathpix_options_hash is distinct from p_mathpix_options_hash
    or parsed.pages_storage_path is distinct from p_pages_path or parsed.full_mmd_storage_path is distinct from p_mmd_path
    then return false; end if;
  -- Retention never silently deletes an older answer's source to make room.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':qa-artifact-quota', 0));
  if not exists (select 1 from user_qa_document_artifacts where user_id = p_user_id and user_document_id = p_document_id and revision = p_revision)
    and (select coalesce(sum(total_bytes),0) from user_qa_document_artifacts where user_id = p_user_id) + p_total_bytes > 1073741824
    then raise exception 'document_artifact_quota'; end if;
  insert into user_qa_document_artifacts(user_id,user_document_id,revision,source_token,manifest_sha256,pdf_sha256,
    manifest_path,pdf_path,total_bytes,page_count)
  values (p_user_id,p_document_id,p_revision,p_source_token,p_manifest_sha256,p_pdf_sha256,prefix || 'manifest.json',prefix || 'source.pdf',p_total_bytes,p_page_count)
  on conflict (user_id,user_document_id,revision) do nothing;
  if not exists (select 1 from user_qa_document_artifacts where user_id = p_user_id and user_document_id = p_document_id
    and revision = p_revision and manifest_sha256 = p_manifest_sha256) then raise exception 'immutable_manifest_conflict'; end if;
  update user_qa_document_preparations set state = 'ready', revision = p_revision, updated_at = now(), error_code = null
    where user_id = p_user_id and user_document_id = p_document_id;
  return true;
end $$;
revoke all on function public.qa_claim_document_preparation(uuid,uuid,text,uuid) from public, anon, authenticated;
revoke all on function public.qa_publish_document_artifact(uuid,uuid,uuid,text,text,text,text,bigint,integer,timestamptz,text,text,text) from public, anon, authenticated;
grant execute on function public.qa_claim_document_preparation(uuid,uuid,text,uuid) to service_role;
grant execute on function public.qa_publish_document_artifact(uuid,uuid,uuid,text,text,text,text,bigint,integer,timestamptz,text,text,text) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('qa-document-artifacts','qa-document-artifacts',false,134217728,array['application/json','text/plain','application/pdf'])
on conflict(id) do nothing;
drop policy if exists "Upload own leased document candidate" on storage.objects;
create policy "Upload own leased document candidate" on storage.objects for insert to authenticated with check (
  bucket_id = 'qa-document-artifacts' and exists (
    select 1 from public.user_qa_document_preparations p join public.user_documents d on d.id = p.user_document_id
    where p.user_id = auth.uid() and d.user_id = auth.uid() and d.deleted_at is null
      and p.state = 'building' and p.lease_expires_at > now()
      and name = 'candidates/' || p.user_id::text || '/' || p.user_document_id::text || '/' || p.lease_token::text || '/artifact.json'
  )
);
drop policy if exists "Read published active document artifacts" on storage.objects;
create policy "Read published active document artifacts" on storage.objects for select to authenticated using (
  bucket_id = 'qa-document-artifacts' and exists (
    select 1 from public.user_qa_document_artifacts a join public.user_documents d on d.id = a.user_document_id
    where a.user_id = auth.uid() and d.user_id = auth.uid() and d.deleted_at is null
      and name like regexp_replace(a.manifest_path, 'manifest[.]json$', '') || '%'
  )
);
-- No owner UPDATE/DELETE policy: a published revision is not a mutable cache.
notify pgrst, 'reload schema';
commit;
