import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D='dddddddd-dddd-4ddd-8ddd-dddddddddddd', E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const L1='11111111-1111-4111-8111-111111111111', L2='22222222-2222-4222-8222-222222222222';
const digest='a'.repeat(64), token='b'.repeat(64), revision='c'.repeat(64), manifest='d'.repeat(64), stamp='2026-09-25T00:00:00Z';
const prefix=`published/${A}/${D}/${revision}/${L1}/`;
let db;
async function asRole(role,user,fn) { return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);return fn(tx);}); }
async function claim(user=A, document=D, lease=L1, source=token) {
 return (await asRole('service_role',user,tx=>tx.query('select qa_claim_document_preparation($1,$2,$3,$4) as ok',[user,document,source,lease]))).rows[0].ok;
}
async function publish(patch={}) {
 const p={user:A,doc:D,lease:L1,source:token,revision,manifest,pdf:digest,bytes:1000,pages:1,stamp,options:'options',pagesPath:'pages.json',mmdPath:'full.mmd',...patch};
 return (await asRole('service_role',p.user,tx=>tx.query('select qa_publish_document_artifact($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as ok',Object.values(p)))).rows[0].ok;
}
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage;
 create table auth.users(id uuid primary key); insert into auth.users values ('${A}'),('${B}');
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth,storage to authenticated,service_role;
 create table user_documents(id uuid primary key,user_id uuid,content_sha256 text,deleted_at timestamptz);
 insert into user_documents values ('${D}','${A}','sha256-${digest}',null),('${E}','${B}','sha256-${digest}',null);
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 grant all on storage.objects to authenticated,service_role; grant select on user_documents to authenticated,service_role;`);
 const schema=await readFile(new URL('../../supabase/schema.sql',import.meta.url),'utf8');
 const start=schema.indexOf('create table if not exists public.user_mathpix_documents (');
 await db.exec(schema.slice(start,schema.indexOf('\n);',start)+3));
 await db.query(`insert into user_mathpix_documents(user_id,content_sha256,mathpix_options_hash,user_document_id,pdf_fingerprint,file_name,file_size,status,updated_at,pages_storage_path,full_mmd_storage_path)
 values ($1,$2,'options',$3,'synthetic','synthetic.pdf',100,'completed',$4,'pages.json','full.mmd')`,[A,`sha256-${digest}`,D,stamp]);
 await db.exec('grant select on user_mathpix_documents to authenticated,service_role');
 const sql=await readFile(new URL('../../supabase/migrations/20260925_qa_document_artifacts.sql',import.meta.url),'utf8');
 await db.exec(sql);await db.exec(sql);
});
after(async()=>{await db?.close();});

test('a second device cannot claim a live lease, while another user has an independent lease',async()=>{
 assert.equal(await claim(),true);assert.equal(await claim(A,D,L2),false);
 assert.equal(await claim(B,E,L2),true);
 await assert.rejects(claim(B,D,L2),/document_not_available/);
 await assert.rejects(asRole('authenticated',A,tx=>tx.query('select qa_claim_document_preparation($1,$2,$3,$4)',[A,D,token,L2])),/permission denied/);
});
test('candidate upload is restricted to the current owned lease and publication cannot be forged',async()=>{
 const own=`candidates/${A}/${D}/${L1}/artifact.json`;
 await asRole('authenticated',A,tx=>tx.query("insert into storage.objects(bucket_id,name) values ('qa-document-artifacts',$1)",[own]));
 for(const [user,path] of [[B,own],[A,`candidates/${A}/${D}/${L2}/artifact.json`],[A,prefix+'manifest.json']])
  await assert.rejects(asRole('authenticated',user,tx=>tx.query("insert into storage.objects(bucket_id,name) values ('qa-document-artifacts',$1)",[path])),/row-level security/);
 await assert.rejects(asRole('authenticated',A,tx=>tx.query('insert into user_qa_document_artifacts(user_id) values ($1)',[A])),/permission denied/);
});
test('a partial upload is invisible until publication atomically installs a validated manifest',async()=>{
 await db.query("insert into storage.objects(bucket_id,name) values ('qa-document-artifacts',$1),('qa-document-artifacts',$2)",[prefix+'manifest.json',prefix+'source.pdf']);
 assert.equal((await asRole('authenticated',A,tx=>tx.query("select * from storage.objects where name like 'published/%'"))).rows.length,0);
 assert.equal(await publish(),false); // Not yet admitted to validation.
 await db.query("update user_qa_document_preparations set state='validating' where user_id=$1",[A]);
 assert.equal(await publish({lease:L2}),false);
 assert.equal(await publish({stamp:'2020-01-01T00:00:00Z'}),false);
 assert.equal(await publish(),true);
 assert.equal((await asRole('authenticated',A,tx=>tx.query("select * from storage.objects where name like 'published/%'"))).rows.length,2);
 assert.equal((await asRole('authenticated',B,tx=>tx.query('select * from user_qa_document_artifacts'))).rows.length,0);
});
test('a later parse retains the older snapshot; content-addressed manifests cannot be overwritten',async()=>{
 assert.equal(await claim(A,D,L2),true);
 await db.query("update user_qa_document_preparations set state='validating' where user_id=$1",[A]);
 await assert.rejects(publish({lease:L2,manifest:'f'.repeat(64)}),/immutable_manifest_conflict/);
 assert.equal(await publish({lease:L2}),true);
 await db.query("update user_mathpix_documents set updated_at='2026-09-26T00:00:00Z' where user_id=$1",[A]);
 assert.equal((await asRole('authenticated',A,tx=>tx.query('select * from user_qa_document_artifacts'))).rows.length,1);
 assert.equal((await asRole('authenticated',A,tx=>tx.query("select * from storage.objects where name like 'published/%'"))).rows.length,2);
});
test('expired leases can resume with a new token; deleting a document revokes all retained remote versions',async()=>{
 assert.equal(await claim(A,D,L1),true);
 await db.query("update user_qa_document_preparations set lease_expires_at=now()-interval '1 second' where user_id=$1",[A]);
 assert.equal(await claim(A,D,L2),true);
 assert.equal(await publish(),false);
 await db.query('update user_documents set deleted_at=now() where id=$1',[D]);
 assert.equal((await asRole('authenticated',A,tx=>tx.query('select * from user_qa_document_artifacts'))).rows.length,0);
 assert.equal((await asRole('authenticated',A,tx=>tx.query('select * from storage.objects'))).rows.length,0);
 await assert.rejects(claim(),/document_not_available/);
 assert.equal((await db.query('select count(*)::int as n from user_qa_document_artifacts')).rows[0].n,1); // Retained data was not destructively deleted.
});
