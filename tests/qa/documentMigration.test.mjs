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
});
after(async()=>{await db?.close();});

test('migration is repeatable and preserves indexed chunk citations',async()=>{
 const rows=await db.query("select chunk_id,source_kind from user_qa_citations where document_title='old citation'");
 assert.deepEqual(rows.rows,[{chunk_id:C,source_kind:'indexed_chunk'}]);
});
test('authorized native citation can be stored without a fabricated chunk',async()=>{
 const result=await asUser(A,tx=>insert(tx)); assert.equal(result.rows[0].chunk_id,null); assert.equal(result.rows[0].source_kind,'document_text');
});
test('incomplete source locator cannot exploit SQL CHECK null semantics',async()=>{
 await assert.rejects(()=>insert(db,{source_locator:{}}),/check constraint/);
 await assert.rejects(()=>insert(db,{source_locator:locator({version:undefined})}),/check constraint/);
});
test('indexed source still requires a real chunk foreign key',async()=>{
 await assert.rejects(()=>insert(db,{source_kind:'indexed_chunk',chunk_id:null}),/check constraint/);
 await assert.rejects(()=>insert(db,{source_kind:'indexed_chunk',chunk_id:'44444444-4444-4444-8444-444444444444'}),/foreign key/);
});
test('cross-user read and write are rejected by RLS',async()=>{
 const result=await asUser(B,tx=>tx.query('select * from user_qa_citations')); assert.equal(result.rows.length,0);
 await assert.rejects(()=>asUser(B,tx=>insert(tx)),/row-level security/);
 await assert.rejects(()=>asUser(B,tx=>insert(tx,{user_id:B,user_document_id:E})),/row-level security/);
});
test('stale parsing revision and unrelated source identity are rejected',async()=>{
 await assert.rejects(()=>asUser(A,tx=>insert(tx,{source_locator:locator({sourceUpdatedAt:'2020-01-01T00:00:00Z'})})),/row-level security/);
 await assert.rejects(()=>asUser(A,tx=>insert(tx,{source_record_id:'other-source'})),/row-level security/);
});
test('deleted source cannot authorize new citations',async()=>{
 await db.exec("update user_mathpix_documents set deleted_at=now()");
 try {await assert.rejects(()=>asUser(A,tx=>insert(tx)),/row-level security/);} finally {await db.exec('update user_mathpix_documents set deleted_at=null');}
});
test('native tool and model-call log enums coexist with legacy values',async()=>{
 const step=await db.query(`insert into user_qa_agent_steps(user_id,message_id,step_index,kind,summary,tool_name) values ($1,$2,0,'tool_call','Read document','read_document') returning id`,[A,M]);
 await db.query(`insert into user_qa_tool_calls(user_id,step_id,tool_name,status) values ($1,$2,'read_document','success')`,[A,step.rows[0].id]);
 await db.query(`insert into user_qa_api_logs(id,user_id,message_id,request_kind,status,request_started_at,request_finished_at) values (gen_random_uuid(),$1,$2,'model-call','success',now(),now())`,[A,M]);
});
