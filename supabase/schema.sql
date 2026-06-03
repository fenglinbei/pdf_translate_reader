create extension if not exists pgcrypto;

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
  open_count integer not null default 1 check (open_count >= 0),
  deleted_at timestamptz
);

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
