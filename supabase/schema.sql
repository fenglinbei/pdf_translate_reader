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
  title text,
  authors text[] not null default '{}'::text[],
  publication_year integer,
  publication_venue text,
  doi text,
  arxiv_id text,
  abstract text,
  reading_status text not null default 'inbox'
    check (reading_status in ('inbox', 'to-read', 'reading', 'finished')),
  starred_at timestamptz,
  archived_at timestamptz,
  library_updated_at timestamptz not null default now(),
  library_fts tsvector,
  deleted_at timestamptz
);

alter table public.user_documents
  add column if not exists last_zoom double precision,
  add column if not exists title text,
  add column if not exists authors text[] not null default '{}'::text[],
  add column if not exists publication_year integer,
  add column if not exists publication_venue text,
  add column if not exists doi text,
  add column if not exists arxiv_id text,
  add column if not exists abstract text,
  add column if not exists reading_status text not null default 'inbox',
  add column if not exists starred_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists library_updated_at timestamptz not null default now(),
  add column if not exists library_fts tsvector;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_documents'::regclass
      and conname = 'user_documents_reading_status_check'
  ) then
    alter table public.user_documents
      add constraint user_documents_reading_status_check
      check (reading_status in ('inbox', 'to-read', 'reading', 'finished'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_documents'::regclass
      and conname = 'user_documents_publication_year_check'
  ) then
    alter table public.user_documents
      add constraint user_documents_publication_year_check
      check (publication_year is null or publication_year between 1 and 3000);
  end if;
end;
$$;

create or replace function public.update_user_document_library_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.title := nullif(btrim(new.title), '');
  new.publication_venue := nullif(btrim(new.publication_venue), '');
  new.doi := nullif(btrim(new.doi), '');
  new.arxiv_id := nullif(btrim(new.arxiv_id), '');
  new.abstract := nullif(btrim(new.abstract), '');
  new.authors := coalesce(new.authors, '{}'::text[]);
  new.library_updated_at := now();
  new.library_fts :=
    setweight(
      to_tsvector(
        'simple'::regconfig,
        coalesce(new.title, '') || ' ' ||
        coalesce(new.pdf_metadata->>'title', '') || ' ' ||
        coalesce(new.display_file_name, '')
      ),
      'A'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        coalesce(array_to_string(new.authors, ' '), '') || ' ' ||
        coalesce(new.pdf_metadata->>'author', '')
      ),
      'B'
    ) ||
    setweight(
      to_tsvector(
        'simple'::regconfig,
        coalesce(new.publication_venue, '') || ' ' ||
        coalesce(new.doi, '') || ' ' ||
        coalesce(new.arxiv_id, '')
      ),
      'B'
    ) ||
    setweight(
      to_tsvector('simple'::regconfig, coalesce(new.abstract, '')),
      'C'
    );
  return new;
end;
$$;

drop trigger if exists trg_user_documents_library_fields
  on public.user_documents;

create trigger trg_user_documents_library_fields
before insert or update of
  display_file_name,
  pdf_metadata,
  title,
  authors,
  publication_year,
  publication_venue,
  doi,
  arxiv_id,
  abstract,
  reading_status,
  starred_at,
  archived_at
on public.user_documents
for each row
execute function public.update_user_document_library_fields();

update public.user_documents
set
  title = coalesce(
    nullif(title, ''),
    nullif(pdf_metadata->>'title', ''),
    nullif(regexp_replace(display_file_name, '[.]pdf$', '', 'i'), '')
  ),
  authors = case
    when cardinality(authors) > 0 then authors
    when nullif(pdf_metadata->>'author', '') is not null
      then array[pdf_metadata->>'author']
    else '{}'::text[]
  end
where library_fts is null;

create unique index if not exists user_documents_active_user_content_sha256_key
  on public.user_documents (user_id, content_sha256)
  where deleted_at is null;

create unique index if not exists user_documents_id_user_key
  on public.user_documents (id, user_id);

create index if not exists user_documents_user_opened_idx
  on public.user_documents (user_id, last_opened_at desc)
  where deleted_at is null;

create index if not exists user_documents_library_updated_idx
  on public.user_documents (user_id, library_updated_at desc)
  where deleted_at is null;

create index if not exists user_documents_library_status_idx
  on public.user_documents (user_id, reading_status, library_updated_at desc)
  where deleted_at is null;

create index if not exists user_documents_library_starred_idx
  on public.user_documents (user_id, starred_at desc)
  where deleted_at is null and starred_at is not null;

create index if not exists user_documents_library_archived_idx
  on public.user_documents (user_id, archived_at desc)
  where deleted_at is null and archived_at is not null;

create index if not exists user_documents_library_fts_idx
  on public.user_documents using gin (library_fts)
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

create table if not exists public.user_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.user_collections(id) on delete set null,
  name text not null check (btrim(name) <> ''),
  description text,
  color text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_collections_parent_not_self check (parent_id is null or parent_id <> id)
);

create unique index if not exists user_collections_user_parent_name_key
  on public.user_collections (
    user_id,
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

create index if not exists user_collections_user_sort_idx
  on public.user_collections (user_id, parent_id, sort_order, lower(name));

create or replace function public.validate_user_collection_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.user_collections parent_collection
    where parent_collection.id = new.parent_id
      and parent_collection.user_id = new.user_id
  ) then
    raise exception 'Collection parent must belong to the same user.';
  end if;

  if exists (
    with recursive ancestors as (
      select parent_collection.id, parent_collection.parent_id
      from public.user_collections parent_collection
      where parent_collection.id = new.parent_id
        and parent_collection.user_id = new.user_id

      union all

      select parent_collection.id, parent_collection.parent_id
      from public.user_collections parent_collection
      join ancestors
        on parent_collection.id = ancestors.parent_id
      where parent_collection.user_id = new.user_id
    )
    select 1
    from ancestors
    where ancestors.id = new.id
  ) then
    raise exception 'Collection hierarchy cannot contain a cycle.';
  end if;

  return new;
end;
$$;

revoke execute
  on function public.validate_user_collection_parent()
  from authenticated, anon, public;

drop trigger if exists trg_user_collections_validate_parent
  on public.user_collections;
create trigger trg_user_collections_validate_parent
before insert or update of parent_id, user_id
on public.user_collections
for each row
execute function public.validate_user_collection_parent();

alter table public.user_collections enable row level security;

drop policy if exists "Users can manage their collections" on public.user_collections;
create policy "Users can manage their collections"
  on public.user_collections
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.user_tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_tags_user_name_key
  on public.user_tags (user_id, lower(name));

create index if not exists user_tags_user_name_idx
  on public.user_tags (user_id, lower(name));

alter table public.user_tags enable row level security;

drop policy if exists "Users can manage their tags" on public.user_tags;
create policy "Users can manage their tags"
  on public.user_tags
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.user_document_collections (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  collection_id uuid not null references public.user_collections(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_document_id, collection_id)
);

create index if not exists user_document_collections_user_collection_idx
  on public.user_document_collections (user_id, collection_id, user_document_id);

alter table public.user_document_collections enable row level security;

drop policy if exists "Users can manage their document collections"
  on public.user_document_collections;
create policy "Users can manage their document collections"
  on public.user_document_collections
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.user_collections collections
      where collections.id = collection_id
        and collections.user_id = auth.uid()
    )
  );

create table if not exists public.user_document_tags (
  user_id uuid not null references auth.users(id) on delete cascade,
  user_document_id uuid not null references public.user_documents(id) on delete cascade,
  tag_id uuid not null references public.user_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_document_id, tag_id)
);

create index if not exists user_document_tags_user_tag_idx
  on public.user_document_tags (user_id, tag_id, user_document_id);

alter table public.user_document_tags enable row level security;

drop policy if exists "Users can manage their document tags"
  on public.user_document_tags;
create policy "Users can manage their document tags"
  on public.user_document_tags
  for all
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.user_documents documents
      where documents.id = user_document_id
        and documents.user_id = auth.uid()
    )
    and exists (
      select 1
      from public.user_tags tags
      where tags.id = tag_id
        and tags.user_id = auth.uid()
    )
  );

create or replace function public.touch_library_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_collections_touch_updated_at
  on public.user_collections;
create trigger trg_user_collections_touch_updated_at
before update on public.user_collections
for each row
execute function public.touch_library_updated_at();

drop trigger if exists trg_user_tags_touch_updated_at
  on public.user_tags;
create trigger trg_user_tags_touch_updated_at
before update on public.user_tags
for each row
execute function public.touch_library_updated_at();

create or replace function public.touch_user_document_library_from_relation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op in ('DELETE', 'UPDATE') then
    update public.user_documents
    set library_updated_at = now()
    where id = old.user_document_id
      and user_id = old.user_id;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    update public.user_documents
    set library_updated_at = now()
    where id = new.user_document_id
      and user_id = new.user_id;
  end if;

  return null;
end;
$$;

revoke execute
  on function public.touch_user_document_library_from_relation()
  from authenticated, anon, public;

drop trigger if exists trg_user_document_collections_touch_document
  on public.user_document_collections;
create trigger trg_user_document_collections_touch_document
after insert or update or delete
on public.user_document_collections
for each row
execute function public.touch_user_document_library_from_relation();

drop trigger if exists trg_user_document_tags_touch_document
  on public.user_document_tags;
create trigger trg_user_document_tags_touch_document
after insert or update or delete
on public.user_document_tags
for each row
execute function public.touch_user_document_library_from_relation();

create or replace function public.set_user_document_organization(
  p_document_id uuid,
  p_collection_ids uuid[] default null,
  p_tag_ids uuid[] default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  requested_count integer;
  visible_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.user_documents documents
    where documents.id = p_document_id
      and documents.user_id = current_user_id
      and documents.deleted_at is null
  ) then
    raise exception 'Document not found.'
      using errcode = 'P0002';
  end if;

  if p_collection_ids is not null then
    select count(*)
    into requested_count
    from (
      select distinct requested.id
      from unnest(p_collection_ids) as requested(id)
      where requested.id is not null
    ) requested_collections;

    if requested_count <> cardinality(p_collection_ids) then
      raise exception 'Collection IDs must be unique and non-null.'
        using errcode = '22023';
    end if;

    select count(*)
    into visible_count
    from public.user_collections collections
    where collections.user_id = current_user_id
      and collections.id = any(p_collection_ids);

    if visible_count <> requested_count then
      raise exception 'One or more collections do not exist.'
        using errcode = '22023';
    end if;
  end if;

  if p_tag_ids is not null then
    select count(*)
    into requested_count
    from (
      select distinct requested.id
      from unnest(p_tag_ids) as requested(id)
      where requested.id is not null
    ) requested_tags;

    if requested_count <> cardinality(p_tag_ids) then
      raise exception 'Tag IDs must be unique and non-null.'
        using errcode = '22023';
    end if;

    select count(*)
    into visible_count
    from public.user_tags tags
    where tags.user_id = current_user_id
      and tags.id = any(p_tag_ids);

    if visible_count <> requested_count then
      raise exception 'One or more tags do not exist.'
        using errcode = '22023';
    end if;
  end if;

  if p_collection_ids is not null then
    delete from public.user_document_collections document_collections
    where document_collections.user_id = current_user_id
      and document_collections.user_document_id = p_document_id;

    insert into public.user_document_collections (
      user_id,
      user_document_id,
      collection_id
    )
    select
      current_user_id,
      p_document_id,
      requested.id
    from (
      select distinct requested_collection.collection_id as id
      from unnest(p_collection_ids)
        as requested_collection(collection_id)
    ) requested;
  end if;

  if p_tag_ids is not null then
    delete from public.user_document_tags document_tags
    where document_tags.user_id = current_user_id
      and document_tags.user_document_id = p_document_id;

    insert into public.user_document_tags (
      user_id,
      user_document_id,
      tag_id
    )
    select
      current_user_id,
      p_document_id,
      requested.id
    from (
      select distinct requested_tag.tag_id as id
      from unnest(p_tag_ids)
        as requested_tag(tag_id)
    ) requested;
  end if;
end;
$$;

revoke execute
  on function public.set_user_document_organization(uuid, uuid[], uuid[])
  from anon, public;
grant execute
  on function public.set_user_document_organization(uuid, uuid[], uuid[])
  to authenticated;

create or replace function public.save_user_library_document(
  p_document_id uuid,
  p_title text,
  p_authors text[],
  p_publication_year integer,
  p_publication_venue text,
  p_doi text,
  p_arxiv_id text,
  p_abstract text,
  p_reading_status text,
  p_collection_ids uuid[],
  p_tag_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_authors text[];
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if p_publication_year is not null
    and p_publication_year not between 1 and 3000
  then
    raise exception 'Publication year must be between 1 and 3000.'
      using errcode = '22023';
  end if;

  if p_reading_status is not null
    and p_reading_status not in ('inbox', 'to-read', 'reading', 'finished')
  then
    raise exception 'Invalid reading status.'
      using errcode = '22023';
  end if;

  select coalesce(
    array_agg(btrim(author) order by ordinal)
      filter (where btrim(author) <> ''),
    '{}'::text[]
  )
  into normalized_authors
  from unnest(coalesce(p_authors, '{}'::text[]))
    with ordinality as requested_authors(author, ordinal);

  perform public.set_user_document_organization(
    p_document_id,
    p_collection_ids,
    p_tag_ids
  );

  update public.user_documents documents
  set
    title = p_title,
    authors = normalized_authors,
    publication_year = p_publication_year,
    publication_venue = p_publication_venue,
    doi = p_doi,
    arxiv_id = p_arxiv_id,
    abstract = p_abstract,
    reading_status = coalesce(p_reading_status, documents.reading_status)
  where documents.id = p_document_id
    and documents.user_id = current_user_id
    and documents.deleted_at is null;

  if not found then
    raise exception 'Document not found.'
      using errcode = 'P0002';
  end if;
end;
$$;

revoke execute
  on function public.save_user_library_document(
    uuid,
    text,
    text[],
    integer,
    text,
    text,
    text,
    text,
    text,
    uuid[],
    uuid[]
  )
  from anon, public;
grant execute
  on function public.save_user_library_document(
    uuid,
    text,
    text[],
    integer,
    text,
    text,
    text,
    text,
    text,
    uuid[],
    uuid[]
  )
  to authenticated;

create or replace function public.batch_update_user_library_documents(
  p_document_ids uuid[],
  p_reading_status text default null,
  p_starred boolean default null,
  p_archived boolean default null,
  p_add_collection_ids uuid[] default null,
  p_remove_collection_ids uuid[] default null,
  p_add_tag_ids uuid[] default null,
  p_remove_tag_ids uuid[] default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  requested_count integer;
  visible_count integer;
begin
  if current_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  select count(*)
  into requested_count
  from (
    select distinct requested.id
    from unnest(coalesce(p_document_ids, '{}'::uuid[])) as requested(id)
    where requested.id is not null
  ) requested_documents;

  if requested_count = 0
    or requested_count <> cardinality(coalesce(p_document_ids, '{}'::uuid[]))
  then
    raise exception 'Document IDs must be non-empty, unique, and non-null.'
      using errcode = '22023';
  end if;

  select count(*)
  into visible_count
  from public.user_documents documents
  where documents.user_id = current_user_id
    and documents.deleted_at is null
    and documents.id = any(p_document_ids);

  if visible_count <> requested_count then
    raise exception 'One or more documents do not exist.'
      using errcode = 'P0002';
  end if;

  if p_reading_status is not null
    and p_reading_status not in ('inbox', 'to-read', 'reading', 'finished')
  then
    raise exception 'Invalid reading status.'
      using errcode = '22023';
  end if;

  if p_add_collection_ids is not null then
    select count(*)
    into requested_count
    from (
      select distinct requested.id
      from unnest(p_add_collection_ids) as requested(id)
      where requested.id is not null
    ) requested_collections;

    if requested_count <> cardinality(p_add_collection_ids) then
      raise exception 'Collection IDs must be unique and non-null.'
        using errcode = '22023';
    end if;

    select count(*)
    into visible_count
    from public.user_collections collections
    where collections.user_id = current_user_id
      and collections.id = any(p_add_collection_ids);

    if visible_count <> requested_count then
      raise exception 'One or more collections do not exist.'
        using errcode = '22023';
    end if;
  end if;

  if p_add_tag_ids is not null then
    select count(*)
    into requested_count
    from (
      select distinct requested.id
      from unnest(p_add_tag_ids) as requested(id)
      where requested.id is not null
    ) requested_tags;

    if requested_count <> cardinality(p_add_tag_ids) then
      raise exception 'Tag IDs must be unique and non-null.'
        using errcode = '22023';
    end if;

    select count(*)
    into visible_count
    from public.user_tags tags
    where tags.user_id = current_user_id
      and tags.id = any(p_add_tag_ids);

    if visible_count <> requested_count then
      raise exception 'One or more tags do not exist.'
        using errcode = '22023';
    end if;
  end if;

  if p_reading_status is not null
    or p_starred is not null
    or p_archived is not null
  then
    update public.user_documents documents
    set
      reading_status = coalesce(p_reading_status, documents.reading_status),
      starred_at = case
        when p_starred is null then documents.starred_at
        when p_starred then now()
        else null
      end,
      archived_at = case
        when p_archived is null then documents.archived_at
        when p_archived then now()
        else null
      end
    where documents.user_id = current_user_id
      and documents.deleted_at is null
      and documents.id = any(p_document_ids);
  end if;

  if coalesce(cardinality(p_remove_collection_ids), 0) > 0 then
    delete from public.user_document_collections document_collections
    where document_collections.user_id = current_user_id
      and document_collections.user_document_id = any(p_document_ids)
      and document_collections.collection_id = any(p_remove_collection_ids);
  end if;

  if coalesce(cardinality(p_remove_tag_ids), 0) > 0 then
    delete from public.user_document_tags document_tags
    where document_tags.user_id = current_user_id
      and document_tags.user_document_id = any(p_document_ids)
      and document_tags.tag_id = any(p_remove_tag_ids);
  end if;

  if coalesce(cardinality(p_add_collection_ids), 0) > 0 then
    insert into public.user_document_collections (
      user_id,
      user_document_id,
      collection_id
    )
    select
      current_user_id,
      requested_document.id,
      requested_collection.id
    from (
      select distinct requested.id
      from unnest(p_document_ids) as requested(id)
    ) requested_document
    cross join (
      select distinct requested.id
      from unnest(p_add_collection_ids) as requested(id)
    ) requested_collection
    on conflict (user_document_id, collection_id) do nothing;
  end if;

  if coalesce(cardinality(p_add_tag_ids), 0) > 0 then
    insert into public.user_document_tags (
      user_id,
      user_document_id,
      tag_id
    )
    select
      current_user_id,
      requested_document.id,
      requested_tag.id
    from (
      select distinct requested.id
      from unnest(p_document_ids) as requested(id)
    ) requested_document
    cross join (
      select distinct requested.id
      from unnest(p_add_tag_ids) as requested(id)
    ) requested_tag
    on conflict (user_document_id, tag_id) do nothing;
  end if;
end;
$$;

revoke execute
  on function public.batch_update_user_library_documents(
    uuid[],
    text,
    boolean,
    boolean,
    uuid[],
    uuid[],
    uuid[],
    uuid[]
  )
  from anon, public;
grant execute
  on function public.batch_update_user_library_documents(
    uuid[],
    text,
    boolean,
    boolean,
    uuid[],
    uuid[],
    uuid[],
    uuid[]
  )
  to authenticated;

drop function if exists public.search_user_library_documents(
  text,
  text[],
  boolean,
  boolean,
  uuid[],
  uuid[],
  boolean,
  integer,
  integer,
  text,
  integer,
  integer
);

create function public.search_user_library_documents(
  p_query text default null,
  p_reading_statuses text[] default null,
  p_starred boolean default null,
  p_archived boolean default false,
  p_collection_ids uuid[] default null,
  p_tag_ids uuid[] default null,
  p_uncategorized boolean default false,
  p_year_from integer default null,
  p_year_to integer default null,
  p_sort text default 'updated-desc',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with normalized as (
    select
      nullif(btrim(coalesce(p_query, '')), '') as query_text,
      greatest(1, least(coalesce(p_limit, 50), 100)) as result_limit,
      greatest(coalesce(p_offset, 0), 0) as result_offset
  ),
  filtered as (
    select documents.*
    from public.user_documents documents
    cross join normalized
    where documents.user_id = auth.uid()
      and documents.deleted_at is null
      and (
        coalesce(cardinality(p_reading_statuses), 0) = 0
        or documents.reading_status = any(p_reading_statuses)
      )
      and (
        p_starred is null
        or (p_starred and documents.starred_at is not null)
        or (not p_starred and documents.starred_at is null)
      )
      and (
        p_archived is null
        or (p_archived and documents.archived_at is not null)
        or (not p_archived and documents.archived_at is null)
      )
      and (
        coalesce(cardinality(p_collection_ids), 0) = 0
        or exists (
          select 1
          from public.user_document_collections document_collections
          where document_collections.user_document_id = documents.id
            and document_collections.collection_id = any(p_collection_ids)
        )
      )
      and (
        coalesce(cardinality(p_tag_ids), 0) = 0
        or exists (
          select 1
          from public.user_document_tags document_tags
          where document_tags.user_document_id = documents.id
            and document_tags.tag_id = any(p_tag_ids)
        )
      )
      and (
        not coalesce(p_uncategorized, false)
        or not exists (
          select 1
          from public.user_document_collections uncategorized_collections
          where uncategorized_collections.user_document_id = documents.id
        )
      )
      and (p_year_from is null or documents.publication_year >= p_year_from)
      and (p_year_to is null or documents.publication_year <= p_year_to)
      and (
        normalized.query_text is null
        or documents.library_fts @@ websearch_to_tsquery(
          'simple'::regconfig,
          normalized.query_text
        )
        or lower(
          concat_ws(
            ' ',
            documents.title,
            documents.pdf_metadata->>'title',
            documents.display_file_name,
            array_to_string(documents.authors, ' '),
            documents.pdf_metadata->>'author',
            documents.publication_year::text,
            documents.publication_venue,
            documents.doi,
            documents.arxiv_id,
            documents.abstract
          )
        ) like '%' || lower(normalized.query_text) || '%'
        or exists (
          select 1
          from public.user_document_tags searched_document_tags
          join public.user_tags searched_tags
            on searched_tags.id = searched_document_tags.tag_id
          where searched_document_tags.user_document_id = documents.id
            and searched_tags.name ilike '%' || normalized.query_text || '%'
        )
        or exists (
          select 1
          from public.user_document_collections searched_document_collections
          join public.user_collections searched_collections
            on searched_collections.id = searched_document_collections.collection_id
          where searched_document_collections.user_document_id = documents.id
            and searched_collections.name ilike '%' || normalized.query_text || '%'
        )
      )
  ),
  ranked as (
    select
      filtered.*,
      row_number() over (
        order by
          case when p_sort = 'title-asc'
            then lower(coalesce(nullif(filtered.title, ''), filtered.display_file_name))
          end asc nulls last,
          case when p_sort = 'title-desc'
            then lower(coalesce(nullif(filtered.title, ''), filtered.display_file_name))
          end desc nulls last,
          case when p_sort = 'imported-desc' then filtered.imported_at end desc nulls last,
          case when p_sort = 'opened-desc' then filtered.last_opened_at end desc nulls last,
          case when p_sort = 'updated-desc' then filtered.library_updated_at end desc nulls last,
          filtered.library_updated_at desc,
          filtered.id
      ) as library_page_order
    from filtered
  ),
  paged as (
    select ranked.*
    from ranked
    cross join normalized
    where ranked.library_page_order > normalized.result_offset
      and ranked.library_page_order <= (
        normalized.result_offset + normalized.result_limit
      )
  ),
  enriched as (
    select
      paged.*,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', collections.id,
              'name', collections.name,
              'description', collections.description,
              'color', collections.color,
              'parent_id', collections.parent_id,
              'sort_order', collections.sort_order,
              'created_at', collections.created_at,
              'updated_at', collections.updated_at
            )
            order by collections.sort_order, lower(collections.name), collections.id
          )
          from public.user_document_collections document_collections
          join public.user_collections collections
            on collections.id = document_collections.collection_id
          where document_collections.user_document_id = paged.id
        ),
        '[]'::jsonb
      ) as collections,
      coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', tags.id,
              'name', tags.name,
              'color', tags.color,
              'created_at', tags.created_at,
              'updated_at', tags.updated_at
            )
            order by lower(tags.name), tags.id
          )
          from public.user_document_tags document_tags
          join public.user_tags tags
            on tags.id = document_tags.tag_id
          where document_tags.user_document_id = paged.id
        ),
        '[]'::jsonb
      ) as tags
    from paged
  )
  select jsonb_build_object(
    'items',
    coalesce(
      (
        select jsonb_agg(
          to_jsonb(enriched)
            - 'user_id'
            - 'library_fts'
            - 'library_page_order'
          order by enriched.library_page_order
        )
        from enriched
      ),
      '[]'::jsonb
    ),
    'total', (select count(*) from filtered),
    'limit', normalized.result_limit,
    'offset', normalized.result_offset
  )
  from normalized;
$$;

revoke execute
  on function public.search_user_library_documents(
    text,
    text[],
    boolean,
    boolean,
    uuid[],
    uuid[],
    boolean,
    integer,
    integer,
    text,
    integer,
    integer
  )
  from anon, public;
grant execute
  on function public.search_user_library_documents(
    text,
    text[],
    boolean,
    boolean,
    uuid[],
    uuid[],
    boolean,
    integer,
    integer,
    text,
    integer,
    integer
  )
  to authenticated;

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
    and exists (
      select 1 from public.user_documents documents
      where documents.user_id = auth.uid()
        and documents.content_sha256 = (storage.foldername(name))[2]
        and documents.deleted_at is null
    )
  );

drop policy if exists "Users can update their Mathpix cache" on storage.objects;
create policy "Users can update their Mathpix cache"
  on storage.objects
  for update
  using (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.user_documents documents
      where documents.user_id = auth.uid()
        and documents.content_sha256 = (storage.foldername(name))[2]
        and documents.deleted_at is null
    )
  )
  with check (
    bucket_id = 'user-mathpix'
    and (storage.foldername(name))[1] = auth.uid()::text
    and exists (
      select 1 from public.user_documents documents
      where documents.user_id = auth.uid()
        and documents.content_sha256 = (storage.foldername(name))[2]
        and documents.deleted_at is null
    )
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
        and documents.deleted_at is null
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
  scope text not null check (scope in ('current', 'current-plus-references', 'library', 'general')),
  reference_document_ids uuid[] not null default '{}',
  constraint user_qa_threads_general_context_check check (
    scope <> 'general' or (active_user_document_id is null and cardinality(reference_document_ids) = 0)
  ),
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
  kind text not null check (kind in ('plan', 'commentary', 'tool_call', 'observation', 'gap_check', 'answer_outline', 'fallback')),
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


-- Literature metadata recognition (2026-09-23).
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


-- QA document tools compatibility (2026-09-24).
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
