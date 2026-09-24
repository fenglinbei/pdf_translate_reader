import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D='dddddddd-dddd-4ddd-8ddd-dddddddddddd', E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const T='11111111-1111-4111-8111-111111111111', M='22222222-2222-4222-8222-222222222222', C='33333333-3333-4333-8333-333333333333';
const content=`sha256-${'a'.repeat(64)}`, revision='2026-09-24T00:00:00.000Z';
let db;
const schema=await readFile(new URL('../../supabase/schema.sql',import.meta.url),'utf8');
const migration=await readFile(new URL('../../supabase/migrations/20260924_qa_document_tools.sql',import.meta.url),'utf8');
const conversationMigration=await readFile(new URL('../../supabase/migrations/20260924_qa_conversation.sql',import.meta.url),'utf8');
function table(name) {
 const start=schema.indexOf(`create table if not exists public.${name} (`);
 assert(start>=0); return schema.slice(start,schema.indexOf('\n);',start)+3);
}
async function asUser(user, fn) {
 return db.transaction(async tx=>{ await tx.exec('set local role authenticated'); await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]); return fn(tx); });
}
function locator(patch={}) {return {version:'citation-locator-v1',kind:'lines',sourceSpans:[{pageNumber:1,lineNumber:1,startOffset:0,endOffset:12}],sourceUpdatedAt:revision,...patch};}
async function insert(tx, patch={}) {
 const row={user_id:A,message_id:M,user_document_id:D,pdf_fingerprint:'synthetic',document_title:'Synthetic paper',page_start:1,page_end:1,
 quoted_text:'Synthetic quote',confidence:'verified',source_kind:'document_text',chunk_id:null,source_version:'source-version',evidence_key:'evidence-key',source_record_id:`${content}:options`,source_locator:locator(),...patch};
 const keys=Object.keys(row); const values=Object.values(row).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);
 return tx.query(`insert into user_qa_citations (${keys.join(',')}) values (${keys.map((_,i)=>`$${i+1}`).join(',')}) returning *`,values);
}
before(async()=>{
 db=new PGlite();
 await db.exec(`create role authenticated; create role service_role bypassrls; create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated,service_role;
 insert into auth.users values ('${A}'),('${B}');
 create table user_documents(id uuid primary key,user_id uuid,content_sha256 text,deleted_at timestamptz);
 insert into user_documents values ('${D}','${A}','${content}',null),('${E}','${B}','${content}',null);
 create table user_paper_chunks(id uuid primary key,user_id uuid,user_document_id uuid);
 insert into user_paper_chunks values ('${C}','${A}','${D}');`);
 for(const name of ['user_mathpix_documents','user_qa_threads','user_qa_messages','user_qa_citations','user_qa_agent_steps','user_qa_tool_calls','user_qa_api_logs']) await db.exec(table(name));
 await db.exec(`alter table user_qa_citations add column line_regions jsonb;
 insert into user_qa_threads(id,user_id,scope,active_user_document_id,title) values ('${T}','${A}','current','${D}','Synthetic thread');
 insert into user_qa_messages(id,user_id,thread_id,role,content,status) values ('${M}','${A}','${T}','assistant','Synthetic answer','success');
 insert into user_mathpix_documents(user_id,content_sha256,mathpix_options_hash,user_document_id,pdf_fingerprint,file_name,file_size,status,updated_at,pages_storage_path)
 values ('${A}','${content}','options','${D}','synthetic','synthetic.pdf',100,'completed','${revision}','synthetic/pages.json');
 insert into user_qa_citations(user_id,message_id,chunk_id,user_document_id,pdf_fingerprint,document_title,page_start,page_end,quoted_text,confidence)
 values ('${A}','${M}','${C}','${D}','synthetic','old citation',1,1,'legacy quote','verified');
 alter table user_qa_citations enable row level security;
 grant select,insert,update,delete on all tables in schema public to authenticated,service_role;`);
 await db.exec(migration); await db.exec(migration);
 await db.exec(conversationMigration); await db.exec(conversationMigration);
 const threadPolicies=schema.slice(schema.indexOf('alter table public.user_qa_threads enable row level security;'),schema.indexOf('create table if not exists public.user_qa_messages ('));
 await db.exec(threadPolicies);
 const upgrade = await readFile(new URL('../../supabase/migrations/20260925_qa_workspace.sql', import.meta.url), 'utf8');
 await db.exec(upgrade); await db.exec(upgrade);
});
after(async()=>{await db?.close();});

test('existing thread is upgraded in place; history, citations, timestamps and original ownership remain', async () => {
 const thread = (await db.query('select * from user_qa_threads where id=$1',[T])).rows[0];
 assert.equal(thread.scope,'workspace'); assert.equal(thread.origin_scope,'current');
 assert.equal(thread.origin_user_document_id,D); assert.equal(thread.active_user_document_id,null);
 assert(thread.workspace_upgraded_at);
 assert.equal((await db.query('select content from user_qa_messages where id=$1',[M])).rows[0].content,'Synthetic answer');
 assert.equal((await db.query("select count(*)::int as n from user_qa_citations where message_id=$1 and quoted_text='legacy quote'",[M])).rows[0].n,1);
 await assert.rejects(()=>db.query("insert into user_qa_threads(user_id,scope,title,active_user_document_id) values ($1,'workspace','Invalid',$2)",[A,D]),/check constraint/);
});
test('workspace citation accepts another owned document but refuses other users and stale or deleted sources', async () => {
 const F='ffffffff-ffff-4fff-8fff-ffffffffffff';
 await db.query('insert into user_documents values ($1,$2,$3,null)',[F,A,content]);
 await db.query(`insert into user_mathpix_documents(user_id,content_sha256,mathpix_options_hash,user_document_id,pdf_fingerprint,file_name,file_size,status,updated_at,pages_storage_path)
 values ($1,$2,'second-options',$3,'second','second.pdf',100,'completed',$4,'second/pages.json')`,[A,content,F,revision]);
 await asUser(A,tx=>insert(tx,{user_document_id:F,source_record_id:content+':second-options'}));
 await assert.rejects(()=>asUser(A,tx=>insert(tx,{user_document_id:E})),/row-level security/);
 await assert.rejects(()=>asUser(B,tx=>insert(tx)),/row-level security/);
 await assert.rejects(()=>asUser(A,tx=>insert(tx,{source_locator:locator({sourceUpdatedAt:'2020-01-01T00:00:00Z'})})),/row-level security/);
 await db.query('update user_documents set deleted_at=now() where id=$1',[F]);
 await assert.rejects(()=>asUser(A,tx=>insert(tx,{user_document_id:F,source_record_id:content+':second-options'})),/row-level security/);
});
test('workspace tool names are accepted and ordinary chat needs no bound document',async()=>{
 await asUser(A,tx=>tx.query("insert into user_qa_threads(user_id,scope,title) values ($1,'workspace','Chat')",[A]));
 for (const [index,name] of ['discover_documents','document_outline','search_document','cite_sources'].entries()) {
 const step=await db.query(`insert into user_qa_agent_steps(user_id,message_id,step_index,kind,summary,tool_name) values ($1,$2,$4,'tool_call','Synthetic tool',$3) returning id`,[A,M,name,index]);
 await db.query(`insert into user_qa_tool_calls(user_id,step_id,tool_name,status) values ($1,$2,$3,'success')`,[A,step.rows[0].id,name]);
 }
});
