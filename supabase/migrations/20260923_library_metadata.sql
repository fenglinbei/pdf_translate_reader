-- Apply before deploying the metadata worker/frontend. Existing documents are
-- deliberately NOT queued or relabelled as automatically generated.
alter table public.user_settings
  add column if not exists library_metadata_ai_enabled boolean not null default true;

alter table public.user_documents
  add column if not exists metadata_sources jsonb not null default '{}'::jsonb,
  add column if not exists metadata_state jsonb not null default '{}'::jsonb,
  add column if not exists metadata_revision bigint not null default 0;

create or replace function public.track_user_document_metadata()
returns trigger language plpgsql set search_path = public as $$
declare
  field text;
  fields text[] := array['title','authors','publication_year','publication_venue','doi','arxiv_id','abstract'];
  changed boolean := false;
  mode text := coalesce(current_setting('app.metadata_write', true), '');
  source text;
begin
  if tg_op = 'INSERT' then
    new.metadata_state := jsonb_build_object('status','queued','reason','import',
      'requestedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    foreach field in array fields loop
      if (to_jsonb(new)->field) not in ('null'::jsonb, '[]'::jsonb, '""'::jsonb) then
        source := 'user';
        if field in ('title','authors') then source := 'pdf'; end if;
        if field = 'title' and nullif(new.pdf_metadata->>'title','') is null
          and new.title = regexp_replace(new.display_file_name,'[.]pdf$','','i')
          then source := 'filename'; end if;
        new.metadata_sources := jsonb_set(new.metadata_sources,array[field],
          jsonb_build_object('source',source,'locked',source = 'user'));
      end if;
    end loop;
    return new;
  end if;
  foreach field in array fields loop
    if (to_jsonb(new)->field) is distinct from (to_jsonb(old)->field) then
      changed := true;
      if mode not in ('auto','review') then
        new.metadata_sources := jsonb_set(new.metadata_sources,array[field],
          jsonb_build_object('source','user','locked',true));
        new.metadata_state := jsonb_set(new.metadata_state,'{suggestions}',
          coalesce(new.metadata_state->'suggestions','{}'::jsonb) - field);
      end if;
    end if;
  end loop;
  if changed then new.metadata_revision := old.metadata_revision + 1; end if;
  if new.metadata_state->>'status' = 'needs_review'
    and coalesce(new.metadata_state->'suggestions','{}'::jsonb) = '{}'::jsonb then
    new.metadata_state := jsonb_set(new.metadata_state,'{status}','"completed"'::jsonb);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_user_documents_metadata_tracking on public.user_documents;
create trigger trg_user_documents_metadata_tracking before insert or update
  on public.user_documents for each row execute function public.track_user_document_metadata();

create index if not exists user_documents_metadata_pending_idx
  on public.user_documents ((metadata_state->>'status')) where deleted_at is null;

create or replace function public.queue_document_metadata(p_user_id uuid, p_document_ids uuid[])
returns integer language plpgsql security invoker set search_path = public as $$
declare doc public.user_documents; queued integer := 0; wanted integer;
begin
  wanted := cardinality(p_document_ids);
  if wanted is null or wanted < 1 or wanted > 100 then
    raise exception 'Select between 1 and 100 documents.' using errcode = '22023';
  end if;
  if (select count(*) from public.user_documents where user_id=p_user_id
      and id=any(p_document_ids) and deleted_at is null) <> wanted then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  for doc in select * from public.user_documents where user_id=p_user_id
    and id=any(p_document_ids) and deleted_at is null order by id for update loop
    if coalesce(doc.metadata_state->>'status','') not in ('queued','running') then
      update public.user_documents set metadata_state =
        (metadata_state - 'error' - 'warnings') || jsonb_build_object('status','queued','reason','manual',
          'requestedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        where id=doc.id;
      queued := queued + 1;
    end if;
  end loop;
  return queued;
end;
$$;

create or replace function public.claim_document_metadata_job()
returns jsonb language plpgsql security invoker set search_path = public as $$
declare doc public.user_documents;
begin
  select * into doc from public.user_documents where deleted_at is null and
    (metadata_state->>'status'='queued' or
      (metadata_state->>'status'='running' and coalesce(metadata_state->>'leaseUntil','') <
        to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
    order by metadata_state->>'requestedAt', id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.user_documents set metadata_state = metadata_state || jsonb_build_object(
    'status','running','jobId',gen_random_uuid()::text,
    'leaseUntil',to_char((clock_timestamp()+interval '5 minutes') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    where id=doc.id returning * into doc;
  return to_jsonb(doc);
end;
$$;

create or replace function public.finish_document_metadata_job(
  p_user_id uuid, p_document_id uuid, p_job_id text, p_revision bigint,
  p_patch jsonb, p_sources jsonb, p_state jsonb)
returns boolean language plpgsql security invoker set search_path = public as $$
declare doc public.user_documents; next_doc public.user_documents;
begin
  select * into doc from public.user_documents where id=p_document_id
    and user_id=p_user_id and deleted_at is null for update;
  if not found or doc.metadata_state->>'jobId' is distinct from p_job_id
    or doc.metadata_state->>'status' <> 'running' or doc.metadata_revision <> p_revision
    or coalesce(doc.metadata_state->>'leaseUntil','') <=
      to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') then
    return false;
  end if;
  next_doc := jsonb_populate_record(doc,p_patch);
  perform set_config('app.metadata_write','auto',true);
  update public.user_documents set title=next_doc.title,authors=next_doc.authors,
    publication_year=next_doc.publication_year,publication_venue=next_doc.publication_venue,
    doi=next_doc.doi,arxiv_id=next_doc.arxiv_id,abstract=next_doc.abstract,
    metadata_sources=p_sources, metadata_state=p_state where id=doc.id;
  perform set_config('app.metadata_write','',true);
  return true;
end;
$$;

create or replace function public.apply_user_document_metadata(
  p_document_id uuid, p_job_id text, p_revision bigint, p_fields text[])
returns void language plpgsql security invoker set search_path = public as $$
declare doc public.user_documents; next_doc public.user_documents; field text;
  candidate jsonb; patch jsonb := '{}'::jsonb; sources jsonb; state jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into doc from public.user_documents where id=p_document_id
    and user_id=auth.uid() and deleted_at is null for update;
  if not found then raise exception 'Document not found.' using errcode='P0002'; end if;
  if doc.metadata_state->>'jobId' is distinct from p_job_id or doc.metadata_revision <> p_revision
    or doc.metadata_state->>'status' <> 'needs_review' then
    raise exception 'Metadata changed. Refresh and review the latest suggestions.' using errcode='40001';
  end if;
  if coalesce(cardinality(p_fields),0) < 1 then raise exception 'Select a field.' using errcode='22023'; end if;
  sources := doc.metadata_sources; state := doc.metadata_state;
  foreach field in array p_fields loop
    if field <> all(array['title','authors','publication_year','publication_venue','doi','arxiv_id','abstract'])
      then raise exception 'Invalid metadata field.' using errcode='22023'; end if;
    candidate := state->'suggestions'->field;
    if candidate is null then raise exception 'Suggestion expired.' using errcode='40001'; end if;
    patch := jsonb_set(patch,array[field],candidate->'value');
    sources := jsonb_set(sources,array[field],jsonb_build_object('source',candidate->>'source','locked',true));
    state := jsonb_set(state,'{suggestions}',(state->'suggestions')-field);
  end loop;
  next_doc := jsonb_populate_record(doc,patch);
  perform set_config('app.metadata_write','review',true);
  update public.user_documents set title=next_doc.title,authors=next_doc.authors,
    publication_year=next_doc.publication_year,publication_venue=next_doc.publication_venue,
    doi=next_doc.doi,arxiv_id=next_doc.arxiv_id,abstract=next_doc.abstract,
    metadata_sources=sources,metadata_state=state where id=doc.id;
  perform set_config('app.metadata_write','',true);
end;
$$;

revoke execute on function public.queue_document_metadata(uuid,uuid[]),
  public.claim_document_metadata_job(),
  public.finish_document_metadata_job(uuid,uuid,text,bigint,jsonb,jsonb,jsonb)
  from public,anon,authenticated;
grant execute on function public.queue_document_metadata(uuid,uuid[]),
  public.claim_document_metadata_job(),
  public.finish_document_metadata_job(uuid,uuid,text,bigint,jsonb,jsonb,jsonb) to service_role;
revoke execute on function public.apply_user_document_metadata(uuid,text,bigint,text[]) from public,anon;
grant execute on function public.apply_user_document_metadata(uuid,text,bigint,text[]) to authenticated;

-- Editing an inspector opened before recognition finished must not overwrite
-- the new fields with a stale full-form snapshot.
create or replace function public.save_user_library_document_checked(
  p_document_id uuid, p_revision bigint, p_patch jsonb, p_collection_ids uuid[], p_tag_ids uuid[])
returns void language plpgsql security invoker set search_path = public as $$
declare doc public.user_documents;
begin
  if auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
  select * into doc from public.user_documents where id=p_document_id
    and user_id=auth.uid() and deleted_at is null for update;
  if not found then raise exception 'Document not found.' using errcode='P0002'; end if;
  if doc.metadata_revision <> p_revision then
    raise exception 'Metadata changed. Reopen the editor to review the latest values.' using errcode='40001';
  end if;
  perform public.save_user_library_document(p_document_id,
    p_patch->>'title', array(select jsonb_array_elements_text(coalesce(p_patch->'authors','[]'::jsonb))),
    (p_patch->>'publication_year')::integer, p_patch->>'publication_venue', p_patch->>'doi',
    p_patch->>'arxiv_id', p_patch->>'abstract', p_patch->>'reading_status', p_collection_ids, p_tag_ids);
end;
$$;
revoke execute on function public.save_user_library_document_checked(uuid,bigint,jsonb,uuid[],uuid[]) from public,anon;
grant execute on function public.save_user_library_document_checked(uuid,bigint,jsonb,uuid[],uuid[]) to authenticated;
