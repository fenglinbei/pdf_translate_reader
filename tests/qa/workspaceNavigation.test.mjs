import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { normalizeWorkspaceThreadPatch } from '../../server/routes/qa.mjs';

test('history updates reject foreign fields, blank titles and malformed flags', () => {
  for (const patch of [null, [], {}, { user_id: 'other' }, { title: ' ' }, { title: 'x'.repeat(201) }, { pinned: 'true' }, { deleted: 1 }]) {
    assert.throws(() => normalizeWorkspaceThreadPatch(patch), { code: 'invalid_thread_update' });
  }
  assert.deepEqual(normalizeWorkspaceThreadPatch({ title: ' Research ', pinned: false }), { title: 'Research', pinned: false });
  assert.deepEqual(normalizeWorkspaceThreadPatch({ deleted: false }), { deleted: false });
});

test('navigation migration is additive, repeatable and preserves history and tombstones', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create table user_qa_threads(id int, user_id text, scope text, title text, updated_at timestamptz, deleted_at timestamptz);
      insert into user_qa_threads values (1,'owner','workspace','Original',now(),null),(2,'owner','workspace','Deleted',now(),now());`);
    const migration = await readFile(new URL('../../supabase/migrations/20260925_qa_workspace_navigation.sql', import.meta.url), 'utf8');
    const before = (await db.query('select * from user_qa_threads order by id')).rows;
    await db.exec(migration); await db.exec(migration);
    const after = (await db.query('select * from user_qa_threads order by id')).rows;
    assert.deepEqual(after, before.map(row => ({ ...row, pinned_at: null })));
  } finally { await db.close(); }
});
