import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const schema = await readFile(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const cloudRepository = await readFile(
  new URL("../../src/cloud/pdfCloudRepository.ts", import.meta.url),
  "utf8",
);

describe("literature library schema", () => {
  it("keeps document identity while adding workflow and bibliography fields", () => {
    assert.match(schema, /create table if not exists public\.user_documents/);
    assert.match(schema, /reading_status text not null default 'inbox'/);
    assert.match(schema, /starred_at timestamptz/);
    assert.match(schema, /archived_at timestamptz/);
    assert.match(schema, /library_fts tsvector/);
    assert.match(schema, /create trigger trg_user_documents_library_fields/);
  });

  it("creates user-isolated collections, tags, and document memberships", () => {
    for (const table of [
      "user_collections",
      "user_tags",
      "user_document_collections",
      "user_document_tags",
    ]) {
      assert.match(schema, new RegExp(`create table if not exists public\\.${table}`));
      assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`));
    }
  });

  it("keeps organization and batch mutations atomic in authenticated RPCs", () => {
    for (const rpc of [
      "set_user_document_organization",
      "save_user_library_document",
      "batch_update_user_library_documents",
    ]) {
      assert.match(schema, new RegExp(`create or replace function public\\.${rpc}`));
      assert.match(
        schema,
        new RegExp(`${rpc}\\([\\s\\S]+?security invoker`),
      );
      assert.match(
        schema,
        new RegExp(`grant execute[\\s\\S]+?${rpc}\\([\\s\\S]+?to authenticated`),
      );
    }

    assert.match(
      schema,
      /create trigger trg_user_document_collections_touch_document[\s\S]+?touch_user_document_library_from_relation/,
    );
    assert.match(
      schema,
      /create trigger trg_user_document_tags_touch_document[\s\S]+?touch_user_document_library_from_relation/,
    );
    assert.match(
      cloudRepository,
      /batchUpdateLibraryDocuments\([\s\S]+?\.rpc\("batch_update_user_library_documents"/,
    );
    assert.match(
      cloudRepository,
      /saveLibraryDocument\([\s\S]+?\.rpc\("save_user_library_document"/,
    );
  });

  it("exposes authenticated server-side search without anonymous execution", () => {
    assert.match(schema, /create function public\.search_user_library_documents/);
    assert.match(
      schema,
      /search_user_library_documents\([\s\S]+?security invoker[\s\S]+?websearch_to_tsquery/,
    );
    assert.match(
      schema,
      /revoke execute[\s\S]+?search_user_library_documents\([\s\S]+?from anon, public/,
    );
    assert.match(
      schema,
      /grant execute[\s\S]+?search_user_library_documents\([\s\S]+?to authenticated/,
    );
  });

  it("keeps archived papers out of the legacy quick library", () => {
    assert.match(
      cloudRepository,
      /listCloudPdfLibraryEntries\(\)[\s\S]+?\.is\("deleted_at", null\)[\s\S]+?\.is\("archived_at", null\)/,
    );
  });

  it("restores an exact archived duplicate when it is imported again", () => {
    assert.match(
      cloudRepository,
      /if \(existingRow\) \{[\s\S]+?archived_at: null,[\s\S]+?updateUserDocument/,
    );
  });
});
