import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", B="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID="11111111-1111-1111-1111-111111111111";
let db; let legacyState;
async function insert(owner=A, id=ID) {
  await db.query(`insert into public.user_documents (id,user_id,content_sha256,pdf_fingerprint,display_file_name,file_size,storage_path,title)
    values ($1,$2,$3,$4,'download.pdf',1000,'synthetic.pdf','download')`,[id,owner,`sha256-${"a".repeat(64)}`,id]);
}
async function role(name, user, operation) {
  return db.transaction(async tx=>{
    await tx.exec(`set local role ${name}`);
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user ?? ""]);
    return operation(tx);
  });
}
const claim=()=>role("service_role",null,async tx=>(await tx.query("select public.claim_document_metadata_job() as job")).rows[0].job);
async function finish(job, patch={}, state={status:"completed",suggestions:{}}) {
  return role("service_role",null,async tx=>(await tx.query(`select public.finish_document_metadata_job($1,$2,$3,$4,$5,$6,$7) as saved`,
    [job.user_id,job.id,job.metadata_state.jobId,job.metadata_revision,patch,{title:{source:"crossref",locked:false}},{...state,jobId:job.metadata_state.jobId}])).rows[0].saved);
}
const read=async()=>(await db.query("select * from public.user_documents where id=$1",[ID])).rows[0];

describe("metadata migration on PostgreSQL",()=>{
before(async()=>{
  db=new PGlite();
  const schema=await readFile(new URL("../../supabase/schema.sql",import.meta.url),"utf8");
  const migration=await readFile(new URL("../../supabase/migrations/20260923_library_metadata.sql",import.meta.url),"utf8");
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated,service_role;
    insert into auth.users values ('${A}'),('${B}');`);
  await db.exec("create table public.user_settings (user_id uuid primary key references auth.users(id), payload jsonb not null default '{}')");
  const tableStart=schema.indexOf("create table if not exists public.user_documents (");
  await db.exec(schema.slice(tableStart,schema.indexOf("\n);",tableStart)+3));
  const triggerStart=schema.indexOf("create or replace function public.update_user_document_library_fields()");
  await db.exec(schema.slice(triggerStart,schema.indexOf("\nupdate public.user_documents",triggerStart)));
  await db.exec(`alter table public.user_documents enable row level security;
    create policy own_docs on public.user_documents for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    grant select,insert,update,delete on public.user_documents to authenticated,service_role;
    create function public.set_user_document_organization(uuid,uuid[],uuid[]) returns void language plpgsql as $$ begin return; end $$;`);
  const saveStart=schema.indexOf("create or replace function public.save_user_library_document(");
  await db.exec(schema.slice(saveStart,schema.indexOf("\nrevoke execute",saveStart)));
  await insert();
  await db.exec(migration);
  legacyState=(await read()).metadata_state;
  await db.exec(migration); // A repeat application must not enqueue historical documents.
});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec("truncate public.user_documents");await insert();});

  it("leaves historical documents unqueued and enqueues only new inserts",async()=>{
    assert.deepEqual(legacyState,{});
    const doc=await read();
    assert.equal(doc.metadata_state.status,"queued");
    assert.equal(doc.metadata_sources.title.source,"filename");
    assert.equal(doc.metadata_revision,0);
  });
  it("keeps the AI opt-out when an older client overwrites its settings payload",async()=>{
    await db.query("insert into public.user_settings(user_id,payload,library_metadata_ai_enabled) values ($1,$2,false) on conflict(user_id) do update set library_metadata_ai_enabled=false",[A,{}]);
    await db.query("insert into public.user_settings(user_id,payload) values ($1,$2) on conflict(user_id) do update set payload=excluded.payload",[A,{libraryMetadataAiEnabled:true,sourceLang:"en"}]);
    const setting=(await db.query("select library_metadata_ai_enabled from public.user_settings where user_id=$1",[A])).rows[0];
    assert.equal(setting.library_metadata_ai_enabled,false);
  });
  it("claims once and recovers expired leases with a new token",async()=>{
    const first=await claim(); assert.ok(first.metadata_state.jobId);
    assert.equal(await claim(),null);
    await db.exec(`update public.user_documents set metadata_state=jsonb_set(metadata_state,'{leaseUntil}','"2000-01-01T00:00:00.000Z"')`);
    assert.equal(await finish(first,{title:"Expired lease"}),false);
    const recovered=await claim();
    assert.notEqual(first.metadata_state.jobId,recovered.metadata_state.jobId);
    assert.equal(await finish(first,{title:"stale"}),false);
    assert.equal(await finish(recovered,{title:"Recovered title"}),true);
  });
  it("protects a manual edit and manual clearing while a job is running",async()=>{
    const job=await claim();
    await role("authenticated",A,tx=>tx.query("update public.user_documents set title=$1,authors=$2 where id=$3",["My title",["My author"],ID]));
    await role("authenticated",A,tx=>tx.query("update public.user_documents set authors='{}' where id=$1",[ID]));
    const doc=await read();
    assert.equal(doc.metadata_sources.title.locked,true);
    assert.equal(doc.metadata_sources.authors.locked,true);
    assert.equal(doc.metadata_revision,2);
    assert.equal(await finish(job,{title:"AI title"}),false);
    assert.equal((await read()).title,"My title");
  });
  it("does not mark automatic writes as manual and keeps future edits protected",async()=>{
    const job=await claim();
    assert.equal(await finish(job,{title:"Automatic title"}),true);
    assert.equal((await read()).metadata_sources.title.source,"crossref");
    const search=await db.query("select library_fts @@ plainto_tsquery('simple','Automatic') as found from public.user_documents where id=$1",[ID]);
    assert.equal(search.rows[0].found,true);
    await role("authenticated",A,tx=>tx.query("update public.user_documents set title='My correction' where id=$1",[ID]));
    assert.equal((await read()).metadata_sources.title.source,"user");
  });
  it("applies only selected suggestions and locks accepted values",async()=>{
    const job=await claim();
    await finish(job,{}, {status:"needs_review",suggestions:{title:{value:"Suggested title",source:"crossref"},authors:{value:["Alice"],source:"ai"}}});
    await role("authenticated",A,tx=>tx.query("select public.apply_user_document_metadata($1,$2,$3,$4)",[ID,job.metadata_state.jobId,0,["title"]]));
    const doc=await read();
    assert.equal(doc.title,"Suggested title"); assert.deepEqual(doc.authors,[]);
    assert.equal(doc.metadata_sources.title.locked,true);
    assert.equal(doc.metadata_sources.title.source,"crossref");
    assert.equal(doc.metadata_state.status,"needs_review");
    assert.deepEqual(Object.keys(doc.metadata_state.suggestions),["authors"]);
    await assert.rejects(role("authenticated",A,tx=>tx.query("select public.apply_user_document_metadata($1,$2,$3,$4)",[ID,job.metadata_state.jobId,0,["authors"]])),/changed/);
    await role("authenticated",A,tx=>tx.query("select public.apply_user_document_metadata($1,$2,$3,$4)",[ID,job.metadata_state.jobId,1,["authors"]]));
    assert.equal((await read()).metadata_state.status,"completed");
  });
  it("does not let another user review or queue someone else's document",async()=>{
    const job=await claim(); await finish(job,{}, {status:"needs_review",suggestions:{title:{value:"A title",source:"ai"}}});
    await assert.rejects(role("authenticated",B,tx=>tx.query("select public.apply_user_document_metadata($1,$2,0,$3)",[ID,job.metadata_state.jobId,["title"]])),/not found/);
    await assert.rejects(role("service_role",null,tx=>tx.query("select public.queue_document_metadata($1,$2)",[B,[ID]])),/not found/);
    assert.equal((await read()).title,"download");
  });
  it("restricts worker RPCs to the service role",async()=>{
    await assert.rejects(role("authenticated",A,tx=>tx.exec("select public.claim_document_metadata_job()")),/permission denied/);
    await assert.rejects(role("authenticated",A,tx=>tx.query("select public.queue_document_metadata($1,$2)",[A,[ID]])),/permission denied/);
    await assert.rejects(role("anon",null,tx=>tx.exec("select public.claim_document_metadata_job()")),/permission denied/);
  });
  it("rejects a stale full editor snapshot after automatic enrichment",async()=>{
    const job=await claim(); await finish(job,{title:"Recognized title"});
    await assert.rejects(role("authenticated",A,tx=>tx.query("select public.save_user_library_document_checked($1,0,$2,'{}','{}')",[ID,{title:"Old draft",authors:[]}])),/changed/);
    assert.equal((await read()).title,"Recognized title");
    await role("authenticated",A,tx=>tx.query("select public.save_user_library_document_checked($1,1,$2,'{}','{}')",[ID,{title:"Reviewed correction",authors:[]}]));
    assert.equal((await read()).title,"Reviewed correction");
    assert.equal((await read()).metadata_sources.title.locked,true);
  });
  it("does not complete deleted documents or queue an active duplicate job",async()=>{
    const job=await claim();
    const queued=await role("service_role",null,tx=>tx.query("select public.queue_document_metadata($1,$2) as count",[A,[ID]]));
    assert.equal(queued.rows[0].count,0);
    await db.exec("update public.user_documents set deleted_at=now()");
    assert.equal(await finish(job,{title:"Too late"}),false);
  });
});
