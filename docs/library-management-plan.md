# Literature library management

## Goal

Turn the current flat PDF history into a scalable literature workspace without
changing the reader, translation, MathPix, or Paper QA execution paths.

The library uses one canonical document record and virtual organization:

- collections describe the projects or topics a paper belongs to;
- tags describe cross-project attributes such as methods or datasets;
- reading status tracks workflow independently of classification;
- stars and archive state are independent document attributes;
- saved server-side filters provide system views without duplicating PDFs.

A document may belong to multiple collections and have multiple tags. Moving or
classifying a document never duplicates its PDF, annotations, translations, or
QA artifacts.

## Phase 1 scope

Phase 1 delivers:

- a full-page library workspace that leaves the active reader session mounted;
- system views for all, inbox, to read, reading, finished, starred,
  uncategorized, recent, and archived documents;
- editable bibliographic metadata: title, authors, year, venue, DOI, arXiv ID,
  and abstract;
- hierarchical collections, reusable tags, and document membership editing;
- multi-select and batch status, star, archive, collection, and tag operations;
- server-side metadata search, filtering, sorting, and paginated loading;
- exact-file deduplication through the existing content SHA-256 identity;
- an archive workflow that hides a document without deleting its PDF or reader
  state.

Automatic metadata enrichment is implemented as a follow-up to phase 1. See
[metadata recognition](library-metadata-recognition.md) for its triggers,
field protection rules, AI preference, required migration, and release boundary.
Duplicate merging, recoverable trash, saved custom searches, cross-paper
full-text search, and AI classification remain later phases.

## Implementation status

Phase 1 is implemented in the application and schema:

- the top-bar library button opens the full-page workbench without unmounting
  the active reader;
- document, collection, tag, search, archive, and batch mutations are backed by
  authenticated Supabase queries and transactional RPCs;
- exact duplicates reuse the canonical document, and reimporting an archived
  duplicate restores it to the active library;
- metadata and organization changes refresh both the workbench and the legacy
  quick library;
- desktop and narrow layouts have browser-level interaction coverage.

Before using the feature against an existing Supabase project, apply the
updated `supabase/schema.sql`. The application selects the new literature
columns and RPCs directly, so deploying the frontend before the schema
migration will leave the workbench unavailable.

## Data model

`public.user_documents` remains the canonical record for this phase. It gains
queryable literature-management fields while preserving all existing document
and storage identifiers.

New relations:

- `public.user_collections`
- `public.user_document_collections`
- `public.user_tags`
- `public.user_document_tags`

All records are user-isolated with row-level security. Collection and tag
membership changes reference the existing `user_documents.id`, so current
translation, annotation, MathPix, and QA foreign keys remain valid.

Search uses a trigger-maintained metadata `tsvector`, with substring fallback
for identifiers and text that PostgreSQL's simple text-search configuration
does not tokenize well. Full-paper content remains opt-in through the existing
MathPix/QA indexing flow; opening or searching the library must not create
upstream parsing or indexing jobs.

## Interaction model

New imports start in `inbox`. A typical workflow is:

1. Import one or more PDFs.
2. Review the Inbox.
3. Correct metadata if needed.
4. Add project collections and descriptive tags.
5. Move the paper through `to-read`, `reading`, and `finished`.
6. Archive completed or inactive material without deleting it.

Opening a paper from the library returns to the existing reader and restores the
same cloud-backed reading state as the legacy PDF list.

## Verification

Phase 1 is complete when:

- existing PDF import, open, reading-position restore, translation, annotation,
  MathPix, and QA flows still build and pass their tests;
- all library mutations refresh both the workbench and legacy sidebar;
- archived documents disappear from normal reader history but remain
  recoverable from the Archived view;
- search and filters are enforced by the cloud query rather than only by a
  browser-side array;
- desktop and narrow layouts support opening, selecting, editing, and returning
  to the reader without losing the active document.
