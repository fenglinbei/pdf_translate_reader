create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists vector;

create table if not exists public.signup_email_allowlist (
  email text primary key check (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  note text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signup_email_allowlist enable row level security;

revoke all on public.signup_email_allowlist from anon, authenticated, public;

create or replace function public.normalize_signup_email_allowlist()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email := lower(btrim(new.email));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_signup_email_allowlist_normalize
  on public.signup_email_allowlist;

create trigger trg_signup_email_allowlist_normalize
before insert or update on public.signup_email_allowlist
for each row
execute function public.normalize_signup_email_allowlist();

revoke execute
  on function public.normalize_signup_email_allowlist
  from authenticated, anon, public;

create or replace function public.hook_restrict_signup_by_email_allowlist(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  signup_email text;
  is_allowed boolean;
begin
  signup_email := lower(btrim(coalesce(event->'user'->>'email', '')));

  if signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Email signup is required for this application.'
      )
    );
  end if;

  select exists (
    select 1
    from public.signup_email_allowlist allowlist
    where allowlist.email = signup_email
      and allowlist.active = true
  ) into is_allowed;

  if is_allowed then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'This email is not authorized to sign up.'
    )
  );
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute
  on function public.hook_restrict_signup_by_email_allowlist
  to supabase_auth_admin;
revoke execute
  on function public.hook_restrict_signup_by_email_allowlist
  from authenticated, anon, public;

create table if not exists public.signup_invites (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  note text,
  active boolean not null default true,
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (used_count <= max_uses)
);

alter table public.signup_invites enable row level security;

revoke all on public.signup_invites from anon, authenticated, public;

create table if not exists public.signup_invite_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[0-9a-f]{64}$'),
  invite_id uuid not null references public.signup_invites(id) on delete cascade,
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  consumed_user_id uuid
);

create index if not exists signup_invite_tickets_email_expires_idx
  on public.signup_invite_tickets (email, expires_at desc);

alter table public.signup_invite_tickets enable row level security;

revoke all on public.signup_invite_tickets from anon, authenticated, public;

create table if not exists public.signup_invite_redemptions (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.signup_invites(id) on delete restrict,
  ticket_hash text not null references public.signup_invite_tickets(ticket_hash) on delete restrict,
  email text not null check (email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'),
  user_id uuid,
  redeemed_at timestamptz not null default now()
);

create unique index if not exists signup_invite_redemptions_ticket_hash_key
  on public.signup_invite_redemptions (ticket_hash);

create index if not exists signup_invite_redemptions_invite_idx
  on public.signup_invite_redemptions (invite_id, redeemed_at desc);

alter table public.signup_invite_redemptions enable row level security;

revoke all on public.signup_invite_redemptions from anon, authenticated, public;

create or replace function public.normalize_signup_invite_code(invite_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(lower(btrim(coalesce(invite_code, ''))), '[[:space:]]+', '', 'g');
$$;

create or replace function public.hash_signup_invite_code(invite_code text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(digest(public.normalize_signup_invite_code(invite_code), 'sha256'), 'hex');
$$;

create or replace function public.touch_signup_invite_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_signup_invites_touch_updated_at
  on public.signup_invites;

create trigger trg_signup_invites_touch_updated_at
before update on public.signup_invites
for each row
execute function public.touch_signup_invite_updated_at();

revoke execute
  on function public.normalize_signup_invite_code
  from authenticated, anon, public;
revoke execute
  on function public.hash_signup_invite_code
  from authenticated, anon, public;
revoke execute
  on function public.touch_signup_invite_updated_at
  from authenticated, anon, public;

create or replace function public.create_signup_invite_ticket(
  signup_email text,
  invite_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_email text;
  normalized_code text;
  invite_record public.signup_invites%rowtype;
  raw_ticket text;
  raw_ticket_hash text;
  ticket_expires_at timestamptz;
begin
  normalized_email := lower(btrim(coalesce(signup_email, '')));
  normalized_code := public.normalize_signup_invite_code(invite_code);

  if normalized_email = ''
    or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
  then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'invalid_signup_email',
        'message', 'A valid email address is required.'
      )
    );
  end if;

  if char_length(normalized_code) < 6 then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'invalid_invite_code',
        'message', 'Invite code is invalid or no longer available.'
      )
    );
  end if;

  select *
    into invite_record
  from public.signup_invites
  where code_hash = public.hash_signup_invite_code(normalized_code)
  for update;

  if not found
    or invite_record.active is not true
    or (invite_record.expires_at is not null and invite_record.expires_at <= now())
    or invite_record.used_count >= invite_record.max_uses
  then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'code', 'invalid_invite_code',
        'message', 'Invite code is invalid or no longer available.'
      )
    );
  end if;

  raw_ticket := encode(gen_random_bytes(32), 'hex');
  raw_ticket_hash := encode(digest(raw_ticket, 'sha256'), 'hex');
  ticket_expires_at := now() + interval '10 minutes';

  insert into public.signup_invite_tickets (
    ticket_hash,
    invite_id,
    email,
    expires_at
  )
  values (
    raw_ticket_hash,
    invite_record.id,
    normalized_email,
    ticket_expires_at
  );

  return jsonb_build_object(
    'ticket', raw_ticket,
    'expires_at', ticket_expires_at
  );
end;
$$;

revoke execute
  on function public.create_signup_invite_ticket
  from authenticated, anon, public;
grant execute
  on function public.create_signup_invite_ticket
  to service_role;

create or replace function public.hook_restrict_signup_by_invite_ticket(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  signup_email text;
  raw_ticket text;
  raw_ticket_hash text;
  ticket_record public.signup_invite_tickets%rowtype;
  invite_record public.signup_invites%rowtype;
  signup_user_id uuid;
begin
  signup_email := lower(btrim(coalesce(event->'user'->>'email', '')));
  raw_ticket := coalesce(
    event->'user'->'raw_user_meta_data'->>'invite_ticket',
    event->'user'->'user_metadata'->>'invite_ticket',
    ''
  );
  raw_ticket := lower(btrim(raw_ticket));
  signup_user_id := nullif(event->'user'->>'id', '')::uuid;

  if signup_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Email signup is required for this application.'
      )
    );
  end if;

  if raw_ticket = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code is required to create an account.'
      )
    );
  end if;

  raw_ticket_hash := encode(digest(raw_ticket, 'sha256'), 'hex');

  select *
    into ticket_record
  from public.signup_invite_tickets
  where ticket_hash = raw_ticket_hash
  for update;

  if not found then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code is invalid or no longer available.'
      )
    );
  end if;

  if ticket_record.email <> signup_email then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code was requested for a different email.'
      )
    );
  end if;

  if ticket_record.used_at is not null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code has already been used.'
      )
    );
  end if;

  if ticket_record.expires_at <= now() then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite check expired. Submit the invite code again.'
      )
    );
  end if;

  select *
    into invite_record
  from public.signup_invites
  where id = ticket_record.invite_id
  for update;

  if not found
    or invite_record.active is not true
    or (invite_record.expires_at is not null and invite_record.expires_at <= now())
    or invite_record.used_count >= invite_record.max_uses
  then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Invite code is invalid or no longer available.'
      )
    );
  end if;

  update public.signup_invite_tickets
  set used_at = now(),
      consumed_user_id = signup_user_id
  where ticket_hash = ticket_record.ticket_hash;

  update public.signup_invites
  set used_count = used_count + 1
  where id = invite_record.id;

  insert into public.signup_invite_redemptions (
    invite_id,
    ticket_hash,
    email,
    user_id
  )
  values (
    invite_record.id,
    ticket_record.ticket_hash,
    signup_email,
    signup_user_id
  );

  return '{}'::jsonb;
end;
$$;

grant usage on schema public to service_role;
grant usage on schema public to supabase_auth_admin;
grant execute
  on function public.hook_restrict_signup_by_invite_ticket
  to supabase_auth_admin;
revoke execute
  on function public.hook_restrict_signup_by_invite_ticket
  from authenticated, anon, public;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-pdfs', 'user-pdfs', false, 104857600, array['application/pdf'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-mathpix', 'user-mathpix', false, 104857600, array['application/json', 'text/plain'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content_sha256 text not null check (content_sha256 ~ '^sha256-[0-9a-f]{64}$'),
  pdf_fingerprint text not null,
  display_file_name text not null,
  file_size bigint not null check (file_size > 0),
  mime_type text not null default 'application/pdf',
  storage_path text not null,
  pdf_metadata jsonb,
  imported_at timestamptz not null default now(),
  last_opened_at timestamptz not null default now(),
  last_page_index integer,
  last_scroll_top double precision,
  last_zoom double precision,
  open_count integer not null default 1 check (open_count >= 0),
  deleted_at timestamptz
);

alter table public.user_documents
  add column if not exists last_zoom double precision;

create unique index if not exists user_documents_active_user_content_sha256_key
  on public.user_documents (user_id, content_sha256)
  where deleted_at is null;

create index if not exists user_documents_user_opened_idx
  on public.user_documents (user_id, last_opened_at desc)
  where deleted_at is null;

alter table public.user_documents enable row level security;

drop policy if exists "Users can read their documents" on public.user_documents;
create policy "Users can read their documents"
  on public.user_documents
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their documents" on public.user_documents;
create policy "Users can insert their documents"
  on public.user_documents
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their documents" on public.user_documents;
create policy "Users can update their documents"
  on public.user_documents
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their documents" on public.user_documents;
create policy "Users can delete their documents"
  on public.user_documents
  for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read their PDFs" on storage.objects;
create policy "Users can read their PDFs"
  on storage.objects
  for select
  using (
    bucket_id = 'user-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can upload their PDFs" on storage.objects;
create policy "Users can upload their PDFs"
  on storage.objects
  for insert
  with check (
    bucket_id = 'user-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can update their PDFs" on storage.objects;
create policy "Users can update their PDFs"
  on storage.objects
  for update
  using (
    bucket_id = 'user-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'user-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their PDFs" on storage.objects;
create policy "Users can delete their PDFs"
  on storage.objects
  for delete
  using (
    bucket_id = 'user-pdfs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can read their Mathpix cache" on storage.objects;
create policy "Users can read their Mathpix cache"
  on storage.objects
  for select
  using (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can upload their Mathpix cache" on storage.objects;
create policy "Users can upload their Mathpix cache"
  on storage.objects
  for insert
  with check (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can update their Mathpix cache" on storage.objects;
create policy "Users can update their Mathpix cache"
  on storage.objects
  for update
  using (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their Mathpix cache" on storage.objects;
create policy "Users can delete their Mathpix cache"
  on storage.objects
  for delete
  using (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create table if not exists public.user_document_pins (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  pin_id text not null,
  pdf_fingerprint text not null,
  page_index integer not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_document_id, pin_id)
);

create index if not exists user_document_pins_user_document_idx
  on public.user_document_pins (user_id, user_document_id, updated_at desc);

alter table public.user_document_pins enable row level security;

drop policy if exists "Users can manage their document pins" on public.user_document_pins;
create policy "Users can manage their document pins"
  on public.user_document_pins
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
  );

create table if not exists public.user_translation_cache (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  cache_key text not null,
  pdf_fingerprint text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_document_id, cache_key)
);

create index if not exists user_translation_cache_user_document_idx
  on public.user_translation_cache (user_id, user_document_id, updated_at desc);

alter table public.user_translation_cache enable row level security;

drop policy if exists "Users can manage their translation cache" on public.user_translation_cache;
create policy "Users can manage their translation cache"
  on public.user_translation_cache
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
  );

create table if not exists public.user_paper_contexts (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid primary key references public.user_documents(id) on delete cascade,
  pdf_fingerprint text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.user_paper_contexts enable row level security;

drop policy if exists "Users can manage their paper contexts" on public.user_paper_contexts;
create policy "Users can manage their paper contexts"
  on public.user_paper_contexts
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
  );

create table if not exists public.user_pinned_translation_cards (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  card_key text not null,
  pdf_fingerprint text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_document_id, card_key)
);

create index if not exists user_pinned_translation_cards_user_document_idx
  on public.user_pinned_translation_cards (user_id, user_document_id, updated_at desc);

alter table public.user_pinned_translation_cards enable row level security;

drop policy if exists "Users can manage their pinned translation cards" on public.user_pinned_translation_cards;
create policy "Users can manage their pinned translation cards"
  on public.user_pinned_translation_cards
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
  );

create table if not exists public.user_mathpix_documents (
  user_id uuid not null references auth.users(id) on delete cascade,
  content_sha256 text not null check (content_sha256 ~ '^sha256-[0-9a-f]{64}$'),
  mathpix_options_hash text not null,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  pdf_fingerprint text not null,
  file_name text not null,
  file_size bigint not null check (file_size > 0),
  status text not null check (status in ('submitted', 'processing', 'completed', 'error', 'deleted')),
  mathpix_pdf_id text,
  delete_remote_after_cache boolean,
  num_pages integer,
  num_pages_completed integer,
  percent_done double precision,
  pages_storage_path text,
  full_mmd_storage_path text,
  error_message text,
  submitted_at timestamptz,
  completed_at timestamptz,
  remote_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, content_sha256, mathpix_options_hash)
);

create index if not exists user_mathpix_documents_user_document_idx
  on public.user_mathpix_documents (user_id, user_document_id, updated_at desc)
  where deleted_at is null;

alter table public.user_mathpix_documents enable row level security;

drop policy if exists "Users can manage their Mathpix documents" on public.user_mathpix_documents;
create policy "Users can manage their Mathpix documents"
  on public.user_mathpix_documents
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
        and documents.content_sha256 = user_mathpix_documents.content_sha256
    )
  );

create table if not exists public.user_paper_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  pdf_fingerprint text not null,
  content_sha256 text not null check (content_sha256 ~ '^sha256-[0-9a-f]{64}$'),
  chunk_index integer not null check (chunk_index >= 0),
  chunk_hash text not null,
  title text,
  section_path text[],
  page_start integer not null check (page_start >= 1),
  page_end integer not null check (page_end >= page_start),
  text text not null,
  mmd text,
  source text not null check (source in ('mathpix-v3-pdf', 'pdfjs')),
  token_count integer not null default 0 check (token_count >= 0),
  chunker_version text not null,
  embedding_model text,
  embedding_dimensions integer,
  embedding vector(1024),
  fts tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Normalized line regions (0..1 ratios) for precise citation highlighting.
alter table public.user_paper_chunks
  add column if not exists line_regions jsonb;

create unique index if not exists user_paper_chunks_active_chunk_key
  on public.user_paper_chunks (user_document_id, chunker_version, chunk_hash)
  where deleted_at is null;

create index if not exists user_paper_chunks_user_document_idx
  on public.user_paper_chunks (user_id, user_document_id, chunk_index)
  where deleted_at is null;

create or replace function public.update_user_paper_chunks_fts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.fts := to_tsvector(
    'english'::regconfig,
    coalesce(new.title, '') || ' ' ||
    coalesce(array_to_string(new.section_path, ' '), '') || ' ' ||
    coalesce(new.text, '')
  );
  return new;
end;
$$;

drop trigger if exists trg_user_paper_chunks_fts
  on public.user_paper_chunks;

create trigger trg_user_paper_chunks_fts
before insert or update of title, section_path, text
on public.user_paper_chunks
for each row
execute function public.update_user_paper_chunks_fts();

update public.user_paper_chunks
set text = text
where fts is null;

create index if not exists user_paper_chunks_fts_idx
  on public.user_paper_chunks using gin (fts)
  where deleted_at is null;

alter table public.user_paper_chunks
  add column if not exists embedding_model text,
  add column if not exists embedding_dimensions integer,
  add column if not exists embedding vector(1024);

create index if not exists user_paper_chunks_embedding_idx
  on public.user_paper_chunks using hnsw (embedding vector_cosine_ops)
  where deleted_at is null
    and embedding_model = 'voyage-4-large'
    and embedding_dimensions = 1024;

-- PostgreSQL does not allow CREATE OR REPLACE FUNCTION to change the return
-- type (OUT parameters), so drop the existing function first when its shape
-- changes (e.g. adding line_regions to the returned table).
drop function if exists public.match_user_paper_chunks_current(
  uuid,
  uuid,
  text,
  vector(1024),
  text,
  integer,
  integer
);

create or replace function public.match_user_paper_chunks_current(
  p_user_id uuid,
  p_user_document_id uuid,
  p_query_text text,
  p_query_embedding vector(1024) default null,
  p_embedding_model text default null,
  p_embedding_dimensions integer default null,
  p_match_count integer default 12
)
returns table (
  chunk_id uuid,
  user_document_id uuid,
  pdf_fingerprint text,
  document_title text,
  chunk_index integer,
  title text,
  section_path text[],
  page_start integer,
  page_end integer,
  text text,
  mmd text,
  line_regions jsonb,
  vector_score double precision,
  full_text_score double precision,
  metadata_boost double precision,
  score double precision
)
language sql
stable
set search_path = public
as $$
  with normalized_query as (
    select nullif(trim(coalesce(p_query_text, '')), '') as query_text
  ),
  query_terms as (
    select
      query_text,
      case
        when query_text is null then null::tsquery
        else websearch_to_tsquery('english'::regconfig, query_text)
      end as tsq
    from normalized_query
  ),
  scored_chunks as (
    select
      chunks.id as chunk_id,
      chunks.user_document_id,
      chunks.pdf_fingerprint,
      coalesce(nullif(chunks.title, ''), documents.display_file_name) as document_title,
      chunks.chunk_index,
      chunks.title,
      chunks.section_path,
      chunks.page_start,
      chunks.page_end,
      chunks.text,
      chunks.mmd,
      chunks.line_regions,
      case
        when p_query_embedding is not null
          and p_embedding_model is not null
          and p_embedding_dimensions is not null
          and chunks.embedding is not null
          and chunks.embedding_model = p_embedding_model
          and chunks.embedding_dimensions = p_embedding_dimensions
        then greatest(0, 1 - (chunks.embedding <=> p_query_embedding))
        else 0
      end as vector_score,
      greatest(
        case
          when query_terms.tsq is not null and chunks.fts @@ query_terms.tsq
          then ts_rank_cd(chunks.fts, query_terms.tsq)::double precision
          else 0
        end,
        case
          when query_terms.query_text is not null
          then similarity(
            left(
              coalesce(chunks.title, '') || ' ' ||
              coalesce(array_to_string(chunks.section_path, ' '), '') || ' ' ||
              chunks.text,
              1600
            ),
            query_terms.query_text
          )::double precision
          else 0
        end
      ) as full_text_score,
      (
        0.08 +
        case
          when query_terms.query_text is not null
            and similarity(
              coalesce(chunks.title, '') || ' ' ||
              coalesce(array_to_string(chunks.section_path, ' '), ''),
              query_terms.query_text
            ) > 0.08
          then 0.12
          else 0
        end
      )::double precision as metadata_boost
    from public.user_paper_chunks chunks
    join public.user_documents documents
      on documents.id = chunks.user_document_id
     and documents.user_id = chunks.user_id
    cross join query_terms
    where chunks.user_id = p_user_id
      and chunks.user_document_id = p_user_document_id
      and chunks.deleted_at is null
      and documents.deleted_at is null
      and (
        p_query_embedding is not null
        or query_terms.query_text is not null
      )
  )
  select
    scored_chunks.chunk_id,
    scored_chunks.user_document_id,
    scored_chunks.pdf_fingerprint,
    scored_chunks.document_title,
    scored_chunks.chunk_index,
    scored_chunks.title,
    scored_chunks.section_path,
    scored_chunks.page_start,
    scored_chunks.page_end,
    scored_chunks.text,
    scored_chunks.mmd,
    scored_chunks.line_regions,
    scored_chunks.vector_score,
    scored_chunks.full_text_score,
    scored_chunks.metadata_boost,
    (
      scored_chunks.vector_score * 0.50 +
      least(1, scored_chunks.full_text_score * 8) * 0.35 +
      scored_chunks.metadata_boost * 0.15
    )::double precision as score
  from scored_chunks
  order by score desc, chunk_index asc
  limit greatest(1, least(coalesce(p_match_count, 12), 30));
$$;

alter table public.user_paper_chunks enable row level security;

drop policy if exists "Users can manage their paper chunks" on public.user_paper_chunks;
create policy "Users can manage their paper chunks"
  on public.user_paper_chunks
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
        and documents.content_sha256 = user_paper_chunks.content_sha256
    )
  );

create table if not exists public.user_paper_references (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  reference_index text,
  raw_text text not null,
  title text,
  authors text[],
  year integer,
  doi text,
  arxiv_id text,
  matched_user_document_id uuid references public.user_documents(id) on delete set null,
  match_confidence double precision,
  matcher_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists user_paper_references_user_document_idx
  on public.user_paper_references (user_id, user_document_id, created_at desc)
  where deleted_at is null;

create index if not exists user_paper_references_match_idx
  on public.user_paper_references (user_id, matched_user_document_id)
  where deleted_at is null and matched_user_document_id is not null;

alter table public.user_paper_references enable row level security;

drop policy if exists "Users can manage their paper references" on public.user_paper_references;
create policy "Users can manage their paper references"
  on public.user_paper_references
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
    and (
      matched_user_document_id is null
      or exists (
        select 1 from public.user_documents matched_documents
        where matched_documents.id = matched_user_document_id
          and matched_documents.user_id = auth.uid()
      )
    )
  );

create table if not exists public.user_qa_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  active_user_document_id uuid references public.user_documents(id) on delete set null,
  title text not null,
  scope text not null check (scope in ('current', 'current-plus-references', 'library')),
  reference_document_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists user_qa_threads_user_updated_idx
  on public.user_qa_threads (user_id, updated_at desc)
  where deleted_at is null;

create index if not exists user_qa_threads_active_document_idx
  on public.user_qa_threads (user_id, active_user_document_id, updated_at desc)
  where deleted_at is null;

create index if not exists user_qa_threads_reference_documents_idx
  on public.user_qa_threads using gin (reference_document_ids)
  where deleted_at is null;

alter table public.user_qa_threads enable row level security;

drop policy if exists "Users can manage their QA threads" on public.user_qa_threads;
create policy "Users can manage their QA threads"
  on public.user_qa_threads
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      active_user_document_id is null
      or exists (
        select 1 from public.user_documents documents
        where documents.id = active_user_document_id
          and documents.user_id = auth.uid()
      )
    )
    and not exists (
      select 1
      from unnest(reference_document_ids) as reference_document_id
      where not exists (
        select 1 from public.user_documents reference_documents
        where reference_documents.id = reference_document_id
          and reference_documents.user_id = auth.uid()
      )
    )
  );

create table if not exists public.user_qa_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null references public.user_qa_threads(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  status text not null check (status in ('streaming', 'success', 'error', 'aborted')),
  content text not null,
  model text,
  prompt_version text,
  retrieval_snapshot jsonb,
  usage jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists user_qa_messages_thread_idx
  on public.user_qa_messages (user_id, thread_id, created_at asc)
  where deleted_at is null;

alter table public.user_qa_messages enable row level security;

drop policy if exists "Users can manage their QA messages" on public.user_qa_messages;
create policy "Users can manage their QA messages"
  on public.user_qa_messages
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_qa_threads threads
      where threads.id = thread_id
        and threads.user_id = auth.uid()
    )
  );

create table if not exists public.user_qa_citations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.user_qa_messages(id) on delete cascade,
  chunk_id uuid not null references public.user_paper_chunks(id) on delete restrict,
  user_document_id uuid not null references public.user_documents(id) on delete restrict,
  pdf_fingerprint text not null,
  document_title text not null,
  page_start integer not null check (page_start >= 1),
  page_end integer not null check (page_end >= page_start),
  section_path text[],
  quoted_text text not null,
  confidence text not null check (confidence in ('verified', 'weak', 'rejected')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.user_qa_citations
  add column if not exists line_regions jsonb;

create index if not exists user_qa_citations_message_idx
  on public.user_qa_citations (user_id, message_id, created_at asc)
  where deleted_at is null;

create index if not exists user_qa_citations_document_idx
  on public.user_qa_citations (user_id, user_document_id, page_start)
  where deleted_at is null;

alter table public.user_qa_citations enable row level security;

drop policy if exists "Users can manage their QA citations" on public.user_qa_citations;
create policy "Users can manage their QA citations"
  on public.user_qa_citations
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_qa_messages messages
      where messages.id = message_id
        and messages.user_id = auth.uid()
    )
    and exists (
      select 1 from public.user_paper_chunks chunks
      where chunks.id = chunk_id
        and chunks.user_id = auth.uid()
        and chunks.user_document_id = user_qa_citations.user_document_id
    )
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_qa_citations.user_document_id
        and documents.user_id = auth.uid()
    )
  );

create table if not exists public.user_qa_agent_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id uuid not null references public.user_qa_messages(id) on delete cascade,
  step_index integer not null check (step_index >= 0),
  kind text not null check (kind in ('plan', 'tool_call', 'observation', 'gap_check', 'answer_outline', 'fallback')),
  summary text not null,
  tool_name text check (
    tool_name is null
    or tool_name in ('search_current_paper', 'open_chunk', 'verify_citation', 'compose_answer')
  ),
  evidence_ids text[] not null default '{}',
  status text not null default 'success' check (status in ('success', 'error', 'skipped')),
  payload jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (message_id, step_index)
);

create index if not exists user_qa_agent_steps_message_idx
  on public.user_qa_agent_steps (user_id, message_id, step_index)
  where deleted_at is null;

alter table public.user_qa_agent_steps enable row level security;

drop policy if exists "Users can manage their QA agent steps" on public.user_qa_agent_steps;
create policy "Users can manage their QA agent steps"
  on public.user_qa_agent_steps
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_qa_messages messages
      where messages.id = message_id
        and messages.user_id = auth.uid()
    )
  );

create table if not exists public.user_qa_tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid not null references public.user_qa_agent_steps(id) on delete cascade,
  tool_name text not null check (
    tool_name in ('search_current_paper', 'open_chunk', 'verify_citation', 'compose_answer')
  ),
  input jsonb not null default '{}'::jsonb,
  output_summary text,
  result_evidence_ids text[] not null default '{}',
  status text not null check (status in ('success', 'error', 'skipped')),
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists user_qa_tool_calls_step_idx
  on public.user_qa_tool_calls (user_id, step_id, created_at asc)
  where deleted_at is null;

alter table public.user_qa_tool_calls enable row level security;

drop policy if exists "Users can manage their QA tool calls" on public.user_qa_tool_calls;
create policy "Users can manage their QA tool calls"
  on public.user_qa_tool_calls
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_qa_agent_steps steps
      where steps.id = step_id
        and steps.user_id = auth.uid()
    )
  );

create table if not exists public.user_qa_index_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  pdf_fingerprint text not null,
  content_sha256 text not null check (content_sha256 ~ '^sha256-[0-9a-f]{64}$'),
  source text not null check (source in ('mathpix-v3-pdf', 'pdfjs')),
  status text not null check (
    status in ('pending', 'extracting', 'chunking', 'embedding', 'reference-matching', 'ready', 'ready_degraded', 'error')
  ),
  chunker_version text not null,
  embedding_model text not null default 'none',
  embedding_dimensions integer,
  reference_matcher_version text not null,
  retriever_version text not null,
  progress_percent double precision,
  error_message text,
  payload jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists user_qa_index_jobs_active_document_key
  on public.user_qa_index_jobs (user_id, user_document_id)
  where deleted_at is null
    and status in ('pending', 'extracting', 'chunking', 'embedding', 'reference-matching');

create index if not exists user_qa_index_jobs_user_document_idx
  on public.user_qa_index_jobs (user_id, user_document_id, created_at desc)
  where deleted_at is null;

alter table public.user_qa_index_jobs
  add column if not exists embedding_model text not null default 'none',
  add column if not exists embedding_dimensions integer;

alter table public.user_qa_index_jobs
  drop constraint if exists user_qa_index_jobs_status_check;

alter table public.user_qa_index_jobs
  add constraint user_qa_index_jobs_status_check
  check (status in ('pending', 'extracting', 'chunking', 'embedding', 'reference-matching', 'ready', 'ready_degraded', 'error'));

alter table public.user_qa_index_jobs enable row level security;

drop policy if exists "Users can manage their QA index jobs" on public.user_qa_index_jobs;
create policy "Users can manage their QA index jobs"
  on public.user_qa_index_jobs
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
        and documents.content_sha256 = user_qa_index_jobs.content_sha256
    )
  );

create table if not exists public.user_qa_api_logs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid references public.user_documents(id) on delete set null,
  pdf_fingerprint text,
  thread_id uuid references public.user_qa_threads(id) on delete set null,
  message_id uuid references public.user_qa_messages(id) on delete set null,
  request_kind text not null check (
    request_kind in ('index-job', 'answer-stream', 'retrieval', 'rerank', 'citation-verification')
  ),
  status text not null check (status in ('success', 'error', 'aborted')),
  model text,
  prompt_version text,
  retriever_version text,
  payload jsonb,
  usage jsonb,
  error_message text,
  request_started_at timestamptz not null,
  request_finished_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.user_qa_api_logs
  drop constraint if exists user_qa_api_logs_request_kind_check;

alter table public.user_qa_api_logs
  add constraint user_qa_api_logs_request_kind_check
  check (request_kind in ('index-job', 'answer-stream', 'retrieval', 'rerank', 'citation-verification'));

create index if not exists user_qa_api_logs_user_started_idx
  on public.user_qa_api_logs (user_id, request_started_at desc)
  where deleted_at is null;

create index if not exists user_qa_api_logs_user_document_idx
  on public.user_qa_api_logs (user_id, user_document_id, request_started_at desc)
  where deleted_at is null;

alter table public.user_qa_api_logs enable row level security;

drop policy if exists "Users can manage their QA API logs" on public.user_qa_api_logs;
create policy "Users can manage their QA API logs"
  on public.user_qa_api_logs
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (
      user_document_id is null
      or exists (
        select 1 from public.user_documents documents
        where documents.id = user_document_id
          and documents.user_id = auth.uid()
      )
    )
    and (
      thread_id is null
      or exists (
        select 1 from public.user_qa_threads threads
        where threads.id = thread_id
          and threads.user_id = auth.uid()
      )
    )
    and (
      message_id is null
      or exists (
        select 1 from public.user_qa_messages messages
        where messages.id = message_id
          and messages.user_id = auth.uid()
      )
    )
  );

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users can manage their settings" on public.user_settings;
create policy "Users can manage their settings"
  on public.user_settings
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.api_call_logs (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid references public.user_documents(id) on delete set null,
  pdf_fingerprint text not null,
  payload jsonb not null,
  request_started_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists api_call_logs_user_started_idx
  on public.api_call_logs (user_id, request_started_at desc);

create index if not exists api_call_logs_user_document_idx
  on public.api_call_logs (user_id, user_document_id, request_started_at desc);

alter table public.api_call_logs enable row level security;

drop policy if exists "Users can read their API logs" on public.api_call_logs;
create policy "Users can read their API logs"
  on public.api_call_logs
  for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their API logs" on public.api_call_logs;
create policy "Users can insert their API logs"
  on public.api_call_logs
  for insert
  with check (
    auth.uid() = user_id
    and (
      user_document_id is null
      or exists (
        select 1 from public.user_documents documents
        where documents.id = user_document_id
          and documents.user_id = auth.uid()
      )
    )
  );
