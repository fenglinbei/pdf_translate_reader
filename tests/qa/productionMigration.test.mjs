import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { buildQaProductionMigration } from '../../scripts/prepare-qa-production.mjs';

const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', D='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const T='11111111-1111-4111-8111-111111111111', M='22222222-2222-4222-8222-222222222222', C='33333333-3333-4333-8333-333333333333';
async function baseline() {
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table user_documents(id uuid primary key,user_id uuid,content_sha256 text,deleted_at timestamptz);
    create table user_paper_chunks(id uuid primary key,user_id uuid,user_document_id uuid);
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    insert into auth.users values('${A}');insert into user_documents values('${D}','${A}','sha256-${'a'.repeat(64)}',null);
    insert into user_paper_chunks values('${C}','${A}','${D}');`);
  const schema=await readFile(new URL('../../supabase/schema.sql',import.meta.url),'utf8');
  for(const name of ['user_mathpix_documents','user_qa_threads','user_qa_messages','user_qa_citations','user_qa_agent_steps','user_qa_tool_calls','user_qa_api_logs']) {
    const start=schema.indexOf(`create table if not exists public.${name} (`);assert(start>=0);
    await db.exec(schema.slice(start,schema.indexOf('\n);',start)+3));
  }
  await db.exec(`alter table user_qa_citations add column line_regions jsonb;
    insert into user_qa_threads(id,user_id,scope,active_user_document_id,title) values('${T}','${A}','current','${D}','Existing conversation');
    insert into user_qa_messages(id,user_id,thread_id,role,content,status) values('${M}','${A}','${T}','assistant','Existing answer','success');
    insert into user_qa_citations(user_id,message_id,chunk_id,user_document_id,pdf_fingerprint,document_title,page_start,page_end,quoted_text,confidence)
      values('${A}','${M}','${C}','${D}','old','Original paper',1,1,'Original citation','verified');`);
  return db;
}

test('the complete production bundle upgrades old conversations and retains history in one transaction',async t=>{
  const db=await baseline();t.after(()=>db.close());const {sql,sources}=await buildQaProductionMigration();assert.equal(sources.length,6);
  await db.exec(sql);
  const thread=(await db.query('select * from user_qa_threads')).rows[0];
  assert.equal(thread.scope,'workspace');assert.equal(thread.origin_scope,'current');assert.equal(thread.origin_user_document_id,D);assert.equal(thread.active_user_document_id,null);
  assert.equal((await db.query('select content from user_qa_messages')).rows[0].content,'Existing answer');
  assert.equal((await db.query('select quoted_text from user_qa_citations')).rows[0].quoted_text,'Original citation');
  assert.equal((await db.query('select public from storage.buckets')).rows[0].public,false);
  await assert.rejects(db.query('select qa_commit_artifact_answer(null,null,\'\',\'{}\',null,\'[]\')'),/message_not_available/);
  await assert.rejects(db.exec(sql),/artifact_schema_already_present/);await db.exec('rollback');
  assert.equal((await db.query('select count(*)::int n from user_qa_citations')).rows[0].n,1);
});

test('a late migration failure rolls back the earlier thread upgrade and all new schema',async t=>{
  const db=await baseline();t.after(()=>db.close());const {sql}=await buildQaProductionMigration();
  const broken=sql.replace(/commit;\s*$/, "select * from intentionally_missing_release_table;\ncommit;\n");
  await assert.rejects(db.exec(broken),/intentionally_missing_release_table/);await db.exec('rollback');
  assert.equal((await db.query('select scope from user_qa_threads')).rows[0].scope,'current');
  assert.equal((await db.query("select to_regclass('public.user_qa_document_artifacts') name")).rows[0].name,null);
  assert.equal((await db.query('select count(*)::int n from user_qa_citations')).rows[0].n,1);
});
