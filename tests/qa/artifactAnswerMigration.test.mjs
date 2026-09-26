import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {QA_ANSWER_BUDGET} from '../../shared/qaAnswerBudget.mjs';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',D='dddddddd-dddd-4ddd-8ddd-dddddddddddd',T='11111111-1111-4111-8111-111111111111',M='22222222-2222-4222-8222-222222222222';
const revision='a'.repeat(64),hash='b'.repeat(64);let db;
const citation=(n=1,patch={})=>({sourceKind:'document_artifact',sourceVersion:revision,sourceRecordId:revision,evidenceKey:`node:${n}`,cloudDocumentId:D,pdfFingerprint:'f',documentTitle:'Synthetic',pageStart:1,pageEnd:1,quotedText:'Read text.',confidence:'verified',sectionPath:['Results'],sourceLocator:{version:'citation-locator-v2',revision,nodeId:'p1',range:[0,10],manifestSha256:hash,pdfSha256:hash,pages:[1],evidenceId:`C${n}`},...patch});
async function commit(citations,content='Answer [C1]',user=A){return (await db.query('select qa_commit_artifact_answer($1,$2,$3,$4,$5,$6) as result',[user,M,content,{evidence:citations},null,citations])).rows[0].result;}
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${A}'),('${B}');
 create table user_documents(id uuid primary key,user_id uuid,deleted_at timestamptz);insert into user_documents values('${D}','${A}',null);
 create table user_paper_chunks(id uuid primary key);
 create table user_qa_threads(id uuid primary key,user_id uuid,scope text,deleted_at timestamptz);insert into user_qa_threads values('${T}','${A}','workspace',null);
 create table user_qa_document_artifacts(user_id uuid,user_document_id uuid,revision text,manifest_sha256 text,pdf_sha256 text,page_count integer);insert into user_qa_document_artifacts values('${A}','${D}','${revision}','${hash}','${hash}',1);`);
 const schema=await readFile(new URL('../../supabase/schema.sql',import.meta.url),'utf8');
 for(const name of ['user_qa_messages','user_qa_citations']){const start=schema.indexOf(`create table if not exists public.${name} (`);await db.exec(schema.slice(start,schema.indexOf('\n);',start)+3));}
 await db.exec(`alter table user_qa_citations alter column chunk_id drop not null,add column line_regions jsonb,add column source_kind text,add column source_version text,add column evidence_key text,add column source_record_id text,add column source_locator jsonb;
 insert into user_qa_messages(id,user_id,thread_id,role,status,content)values('${M}','${A}','${T}','assistant','streaming','');`);
 const sql=await readFile(new URL('../../supabase/migrations/20260925_qa_artifact_answers.sql',import.meta.url),'utf8');await db.exec(sql);await db.exec(sql);
 const upgrade=await readFile(new URL('../../supabase/migrations/20260926_qa_citation_budget.sql',import.meta.url),'utf8');await db.exec(upgrade);await db.exec(upgrade);
});
after(async()=>{await db?.close();});
test('failed source in a multi-citation batch rolls back every citation and message update',async()=>{
 await assert.rejects(commit([citation(),citation(2,{sourceVersion:'c'.repeat(64)})]),/artifact_not_available/);
 assert.equal((await db.query('select count(*)::int n from user_qa_citations')).rows[0].n,0);
 assert.equal((await db.query('select status from user_qa_messages')).rows[0].status,'streaming');
});
test('foreign/deleted documents and caller privileges are enforced before persistence',async()=>{
 await assert.rejects(commit([citation()],'x',B),/message_not_available/);
 await db.exec('set role authenticated');await assert.rejects(commit([citation()]),/permission denied/);await db.exec('reset role');
 await db.query('update user_documents set deleted_at=now() where id=$1',[D]);await assert.rejects(commit([citation()]),/document_not_available/);
 await db.query('update user_documents set deleted_at=null where id=$1',[D]);
});
test('one transaction commits answer and references; retries are idempotent and preserve first-use order',async()=>{
 const list=[citation(2),citation(1)];const first=await commit(list);assert.equal(first.message.status,'success');assert.equal(first.citations.length,2);
 assert.deepEqual(first.citations.map(c=>c.source_locator.evidenceId),['C1','C2']);
 const second=await commit(list);assert.deepEqual(second.citations.map(c=>c.id),first.citations.map(c=>c.id));
 await assert.rejects(commit(list,'Different content'),/answer_already_committed/);
});
test('unmapped evidence stores null pages and remains a valid source without fabricated page one',async()=>{
 await db.query("update user_qa_messages set status='streaming' where id=$1",[M]);await db.exec('delete from user_qa_citations');
 const source=citation();source.pageStart=null;source.pageEnd=null;source.sourceLocator.pages=[];
 const result=await commit([source]);assert.equal(result.citations[0].page_start,null);assert.equal(result.citations[0].page_end,null);
});
test('upgraded RPC accepts 35 and the shared citation budget, rejects overflow without partial writes',async()=>{
 for(const count of [35,QA_ANSWER_BUDGET.maxCitations,QA_ANSWER_BUDGET.maxCitations+1]){
  await db.query("update user_qa_messages set status='streaming' where id=$1",[M]);await db.exec('delete from user_qa_citations');
  const sources=Array.from({length:count},(_,i)=>citation(i+1));
  if(count>QA_ANSWER_BUDGET.maxCitations){
   await assert.rejects(commit(sources),/invalid_answer_budget/);
   assert.equal((await db.query('select count(*)::int n from user_qa_citations')).rows[0].n,0);
  }else assert.equal((await commit(sources)).citations.length,count);
 }
});
