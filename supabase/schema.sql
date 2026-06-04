create extension if not exists pgcrypto;

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

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('user-pdfs', 'user-pdfs', false, 104857600, array['application/pdf'])
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
