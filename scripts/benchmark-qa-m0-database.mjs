// M0 design/database probe only. Never connects to a server or reads .env.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('../', import.meta.url);
const output = new URL('../docs/fixtures/qa-workspace-m0-database-baseline-2026-09-26.json', import.meta.url);
const schema = await readFile(new URL('supabase/schema.sql', root), 'utf8');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const fixed='2026-09-26T00:00:00Z';
const uuid=(i,owner='a')=>`${i.toString(16).padStart(8,'0')}-0000-4000-${owner}000-000000000001`;
const C1=uuid(900001),C2=uuid(900002),T1=uuid(900003),T2=uuid(900004);
const sha=value=>createHash('sha256').update(value).digest('hex');
const codepointLength=value=>[...value].length;
assert.equal('😀中'.length,3); assert.equal(codepointLength('😀中'),2); assert.equal(Buffer.byteLength('😀中'),7);
const docTables=['user_documents','user_collections','user_tags','user_document_collections','user_document_tags'];
const fragments=[];
function fragment(start,end){const from=schema.indexOf(start);assert(from>=0,start);const to=schema.indexOf(end,from);assert(to>from,end);const sql=schema.slice(from,to);fragments.push({start,sha256:sha(sql)});return sql;}
function table(name){return fragment(`create table if not exists public.${name} (`,`\n);`)+'\n);';}
const db=new PGlite();
const result={version:'qa-m0-database-baseline-v1',status:'measured_design_probe',syntheticOnly:true,productionDatabaseAccess:false,measuredAt:new Date().toISOString(),fixedClock:fixed,environment:{node:process.version,platform:process.platform,architecture:process.arch,hostCpuCount:os.cpus().length,hostMemoryBytes:os.totalmem(),engine:'PGlite 0.5.8 embedded PostgreSQL WASM, in-memory',nativePostgresPreflightCapturedBy:'Manual read-only checks on 2026-09-26; not re-executed by this offline runner',nativePostgresPreflight:'No response at /var/run/postgresql:5432 or 127.0.0.1:5432; only client binaries installed; no postgres/initdb found',resourceLimits:'No 2 CPU / 2 GiB cgroup applied; not production-equivalent'},sources:{schemaSha256:sha(schema),files:['supabase/schema.sql','server/qa/workspace/repository.mjs','src/cloud/pdfCloudRepository.ts']},measurements:[],oracles:[],recall:[],limits:[]};
try{result.sourceHead=process.env.QA_M0_SOURCE_SHA || execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(root),encoding:'utf8'}).trim();}catch{throw new Error('Pass QA_M0_SOURCE_SHA=$(git rev-parse HEAD) when sandbox blocks child-process git.');}
assert.match(result.sourceHead,/^[a-f0-9]{40}$/);
const rss=[];
async function asUser(user,operation,role='authenticated'){assert(['authenticated','service_role'].includes(role));return db.transaction(async tx=>{await tx.exec(`set local role ${role}`);await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);return operation(tx);});}
async function query(sql,params=[],user=A,role='authenticated'){return asUser(user,tx=>tx.query(sql,params),role);}
async function check(name,sql,params,expected,{user=A,extract=r=>r.rows[0]?.n}={}){const actual=extract(await query(sql,params,user));assert.deepEqual(actual,expected,name);result.oracles.push({name,expected,actual,pass:true});return actual;}
const percentile=(values,p)=>values[Math.ceil(values.length*p)-1];
async function measure(name,sql,params=[],kind='existing_equivalent_sql',role='authenticated'){
  for(let i=0;i<3;i++)await query(sql,params,A,role);
  const times=[];let rows;
  for(let i=0;i<15;i++){await asUser(A,async tx=>{const start=performance.now();const r=await tx.query(sql,params);times.push(performance.now()-start);rows=r.rows;},role);}
  const plan=(await query(`explain (analyze,buffers,format json) ${sql}`,params,A,role)).rows[0]['QUERY PLAN'][0];
  times.sort((a,b)=>a-b);
  const text=JSON.stringify(rows);rss.push(process.memoryUsage().rss);
  result.measurements.push({name,kind,databaseRole:role,sql,params,iterations:15,warmups:3,timingIncludes:'embedded SQL execution and result decoding; excludes SET ROLE/transaction setup and network',p50Ms:+percentile(times,.5).toFixed(3),p95Ms:+percentile(times,.95).toFixed(3),minMs:+times[0].toFixed(3),maxMs:+times.at(-1).toFixed(3),returnedRows:rows.length,jsonUtf16Units:text.length,jsonCodePoints:codepointLength(text),jsonUtf8Bytes:Buffer.byteLength(text),plan});
}
const rpc='select public.search_user_library_documents(p_query=>$1,p_archived=>$2,p_collection_ids=>$3,p_tag_ids=>$4,p_limit=>$5,p_offset=>$6) as payload';
const discovery=`select id,content_sha256,title,display_file_name,authors,abstract,publication_year,archived_at from user_documents where user_id=$1 and deleted_at is null and archived_at is null order by last_opened_at desc nulls last,id asc limit $2 offset $3`;
const literal=`select id from user_documents where user_id=$1 and deleted_at is null and archived_at is null and (title ilike $2 escape '\\' or display_file_name ilike $2 escape '\\' or abstract ilike $2 escape '\\') order by id`;
const literalTerm=value=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
const counts=`select count(*)::int n from user_documents where user_id=$1 and deleted_at is null`;
async function seed(n){
 await db.exec('truncate user_document_collections,user_document_tags,user_collections,user_tags,user_documents cascade');
 for(const owner of [A,B]){
  const letter=owner===A?'a':'b';
  const deleted=n===35?'i>33':'i%100=0';const archived=n===35?'i between 32 and 33':'i%10=0';
  await db.query(`insert into user_documents(id,user_id,content_sha256,pdf_fingerprint,display_file_name,file_size,storage_path,title,abstract,publication_year,last_opened_at,archived_at,deleted_at,reading_status)
   select (lpad(to_hex(i),8,'0')||'-0000-4000-${letter}000-000000000001')::uuid,$1,'sha256-'||lpad(to_hex(i),64,'0'),'shared-fingerprint-'||i,'synthetic-'||i||'.pdf',1000,'synthetic-only/'||i,'Synthetic study '||i,repeat('Synthetic metadata only. ',12),2020+i%6,$2::timestamptz-(i/5)*interval '1 minute',case when ${archived} then $2::timestamptz end,case when ${deleted} then $2::timestamptz end,case when i%2=0 then 'reading' else 'to-read' end from generate_series(1,$3::int) i`,[owner,fixed,n]);
 }
 await db.query('insert into user_collections(id,user_id,parent_id,name) values ($1,$2,null,\'Root\'),($3,$2,$1,\'Child\')',[C1,A,C2]);
 await db.query('insert into user_tags(id,user_id,name) values ($1,$2,\'mechanism\'),($3,$2,\'reading\')',[T1,A,T2]);
 for(const [id,condition] of [[C1,n===35?'i<=10':'i%2=0'],[C2,n===35?'i between 6 and 15':'i%3=0']])await db.query(`insert into user_document_collections(user_id,user_document_id,collection_id) select $1,(lpad(to_hex(i),8,'0')||'-0000-4000-a000-000000000001')::uuid,$2 from generate_series(1,$3::int) i where ${condition}`,[A,id,n]);
 for(const [id,condition] of [[T1,n===35?'i<=12':'i%3=0'],[T2,n===35?'i between 6 and 18':'i%5=0']])await db.query(`insert into user_document_tags(user_id,user_document_id,tag_id) select $1,(lpad(to_hex(i),8,'0')||'-0000-4000-a000-000000000001')::uuid,$2 from generate_series(1,$3::int) i where ${condition}`,[A,id,n]);
 await db.exec('analyze');
}
try{
 await db.exec(`create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated,service_role;insert into auth.users values ('${A}'),('${B}');`);
 for(const name of docTables)await db.exec(table(name));
 await db.exec(fragment('create or replace function public.update_user_document_library_fields()','\nupdate public.user_documents'));
 for(const match of schema.slice(0,schema.indexOf('create function public.search_user_library_documents(')).matchAll(/create (?:unique )?index if not exists [\s\S]*?;/g)){if(/on public\.(user_documents|user_collections|user_tags|user_document_collections|user_document_tags)\s/.test(match[0]))await db.exec(match[0]);}
 await db.exec(fragment('create function public.search_user_library_documents(','\nrevoke execute'));
 for(const name of docTables)await db.exec(`alter table public.${name} enable row level security;create policy benchmark_owner on public.${name} for select to authenticated using (user_id=auth.uid());grant select on public.${name} to authenticated,service_role;`);
 result.environment.postgresVersion=(await db.query('select version() version')).rows[0].version;
 result.sources.extractedFragments=fragments;
 await seed(35);
 await check('small_A_live_33',counts,[A],33);await check('small_B_live_33',counts,[B],33,{user:B});
 await check('RLS_foreign_user_param_returns_zero',counts,[B],0);
 await check('small_active_31',counts+' and archived_at is null',[A],31);
 const smallFirst=(await query(discovery,[A,31,0])).rows;assert.equal(smallFirst.length,31);
 const firstPage=smallFirst.slice(0,30);const boundary=firstPage.at(-1);
 const cursorTime=(await query('select last_opened_at from user_documents where id=$1',[boundary.id])).rows[0].last_opened_at;
 const keyset=`select id,title,last_opened_at from user_documents where user_id=$1 and deleted_at is null and archived_at is null and (last_opened_at<$2 or(last_opened_at=$2 and id>$3)) order by last_opened_at desc nulls last,id asc limit 31`;
 const next=(await query(keyset,[A,cursorTime,boundary.id])).rows;
 assert.equal(next.length,1);assert.equal(new Set([...firstPage,...next].map(d=>d.id)).size,31);
 result.oracles.push({name:'31_rows_limit_plus_one_and_keyset',firstPage:30,hasMore:true,secondPage:1,unique:31,pass:true});
 const countJoin=`select count(distinct d.id)::int n from user_documents d join user_document_collections dc on dc.user_document_id=d.id where d.user_id=$1 and d.deleted_at is null and dc.collection_id=any($2::uuid[])`;
 await check('collection_direct_10',countJoin,[A,[C1]],10);
 await check('collection_parent_child_distinct_15',countJoin,[A,[C1,C2]],15);
 const tagsAny=`select count(*)::int n from user_documents d where d.user_id=$1 and d.deleted_at is null and exists(select 1 from user_document_tags dt where dt.user_document_id=d.id and dt.tag_id=any($2::uuid[]))`;
 const tagsAll=`select count(*)::int n from user_documents d where d.user_id=$1 and d.deleted_at is null and (select count(distinct dt.tag_id) from user_document_tags dt where dt.user_document_id=d.id and dt.tag_id=any($2::uuid[]))=cardinality($2::uuid[])`;
 await check('tag_ANY_18',tagsAny,[A,[T1,T2]],18);await check('tag_ALL_7_design_probe',tagsAll,[A,[T1,T2]],7);
 await check('actual_RPC_tag_semantics_ANY_18',rpc,[null,false,null,[T1,T2],30,0],18,{extract:r=>r.rows[0].payload.total});
 await check('actual_RPC_direct_collection_10',rpc,[null,false,[C1],null,30,0],10,{extract:r=>r.rows[0].payload.total});
 // Fixed bilingual oracle: 2 Chinese and 2 English relevant records, 2 irrelevant records.
 const corpus=[['多模态注意力融合','通过注意力融合整合图像和文字。',true],['注意力机制与门控','注意力可选择不同模态的表示。',true],['Attention fusion','Attention combines visual and textual representations.',true],['Cross modal attention','Learned attention weights choose features.',true],['四季农业记录','田地与季节观测。',false],['Simple inventory','Counts of shelves and boxes.',false]];
 for(let i=0;i<corpus.length;i++)await db.query('update user_documents set title=$1,abstract=$2 where id=$3',[corpus[i][0],corpus[i][1],uuid(i+1)]);
 const relevant=corpus.flatMap((v,i)=>v[2]?[uuid(i+1)]:[]);
 for(const [name,terms,expected] of [['zh_literal',['注意力'],2],['en_literal',['attention'],2],['cross_language_no_rewrite',['注意力'],2],['manual_bilingual_rewrite',['注意力','attention'],4]]){
  const ids=new Set();for(const term of terms)for(const row of (await query(literal,[A,literalTerm(term)])).rows)ids.add(row.id);
  const hits=[...ids].filter(id=>relevant.includes(id));assert.equal(hits.length,expected);assert.equal(ids.size,hits.length);
  const rpcIds=new Set();for(const term of terms)for(const item of (await query(rpc,[term,false,null,null,100,0])).rows[0].payload.items)rpcIds.add(item.id);
  assert.deepEqual([...rpcIds].sort(),[...ids].sort());
  result.recall.push({name,terms,relevantTotal:4,retrieved:ids.size,truePositives:hits.length,recall:hits.length/4,precision:hits.length/ids.size,crossLanguageTargetRecall:name==='cross_language_no_rewrite'?0:undefined,methods:['current_agent_literal_equivalent_SQL','actual_library_RPC'],automatedQueryRewrite:false,oracleIds:relevant,returnedIds:[...ids]});
 }
 await check('Chinese_subword_literal_matches_without_FTS_tokenization',literal,[A,literalTerm('注意')],2,{extract:r=>r.rows.length});
 await check('English_simple_search_has_no_inflection_rewrite',literal,[A,literalTerm('attentions')],0,{extract:r=>r.rows.length});
 await check('literal_wildcard_is_escaped',literal,[A,literalTerm('%_')],0,{extract:r=>r.rows.length});
 result.oracles.push({name:'unicode_length_units',input:'😀中',utf16:3,codePoints:2,utf8Bytes:7,pass:true});
 await measure('small_35_discovery_31_rows',discovery,[A,31,0]);
 await measure('small_35_library_RPC',rpc,[null,false,null,null,30,0],'actual_existing_RPC');
 await seed(10000);
 await check('large_A_live_9900',counts,[A],9900);await check('large_A_active_9000',counts+' and archived_at is null',[A],9000);await check('large_B_live_9900',counts,[B],9900,{user:B});
 const valid=Array.from({length:10000},(_,i)=>i+1).filter(i=>i%100!==0);
 await check('large_tag_ANY_independent_JS_oracle',tagsAny,[A,[T1,T2]],valid.filter(i=>i%3===0||i%5===0).length);
 await check('large_tag_ALL_independent_JS_oracle',tagsAll,[A,[T1,T2]],valid.filter(i=>i%3===0&&i%5===0).length);
 await measure('large_10000_discovery_10',discovery,[A,11,0]);
 await measure('large_10000_discovery_deep_offset',discovery,[A,31,8000]);
 await measure('large_10000_library_RPC',rpc,[null,false,null,null,30,0],'actual_existing_RPC');
 await measure('large_10000_count',counts,[A]);
 await measure('large_10000_discovery_service_role',discovery,[A,11,0],'current_QA_service_role_equivalent_SQL','service_role');
 await measure('large_10000_literal_service_role',literal,[A,literalTerm('study 9876')],'current_QA_service_role_equivalent_SQL','service_role');
 await measure('large_10000_fts_service_role',`select id from user_documents where user_id=$1 and deleted_at is null and library_fts @@ websearch_to_tsquery('simple',$2)`,[A,'9876'],'M0_FTS_index_probe_service_role','service_role');
 await measure('large_10000_tag_ANY',tagsAny,[A,[T1,T2]],'M0_design_probe_SQL');
 await measure('large_10000_tag_ALL',tagsAll,[A,[T1,T2]],'M0_design_probe_SQL');
 await measure('large_10000_collection_dedup',countJoin,[A,[C1,C2]],'M0_design_probe_SQL');
 await measure('large_10000_literal_contains',literal,[A,literalTerm('study 9876')]);
 await measure('large_10000_fts_exact_token',`select id from user_documents where user_id=$1 and deleted_at is null and library_fts @@ websearch_to_tsquery('simple',$2)`,[A,'9876'],'existing_index_isolated_SQL_probe');
 const anchor=(await query(`select id,last_opened_at from user_documents where user_id=$1 and deleted_at is null and archived_at is null order by last_opened_at desc nulls last,id asc offset 7999 limit 1`,[A])).rows[0];
 const cursorParams=[A,anchor.last_opened_at,anchor.id];
 const offsetIds=(await query(discovery,[A,31,8000])).rows.map(r=>r.id);
 assert.deepEqual((await query(keyset,cursorParams)).rows.map(r=>r.id),offsetIds);
 await measure('large_keyset_existing_indexes',keyset,cursorParams,'M0_design_probe_SQL');
 await db.exec('create index m0_probe_user_opened_id on user_documents(user_id,last_opened_at desc,id asc) where deleted_at is null and archived_at is null;analyze user_documents');
 await measure('large_keyset_candidate_index',keyset,cursorParams,'M0_design_probe_SQL_and_ephemeral_index');
 result.oracles.push({name:'deep_keyset_matches_offset_static_dataset',offset:8000,returned:31,pass:true,consistency:'live_keyset, no cross-request snapshot guarantee'});
 // Candidate card/scan/cache budgets evaluated as byte/character accounting, not a shipping cache.
 const sample='😀中文摘要'.repeat(100);
 const cards=Array.from({length:30},(_,i)=>({record:`O${i+1}`,title:`合成文档 ${i+1}`,preview:sample.slice(0,300)}));
 const serialized=JSON.stringify(cards),entryBytes=Buffer.byteLength(serialized);
 result.budgetProbe={kind:'M0_accounting_probe_not_runtime_cache',cardCount:30,previewLimitUtf16:300,totalJsonUtf16:serialized.length,totalJsonCodePoints:codepointLength(serialized),totalJsonUtf8Bytes:entryBytes,userCacheCapBytes:2*1024*1024,processCacheCapBytes:16*1024*1024,completeEntriesPerUser:Math.floor(2*1024*1024/entryBytes),completeEntriesPerProcess:Math.floor(16*1024*1024/entryBytes),scanRecordLimit:2000,scanCharLimit:1000000,scanReturnLimit:14000,limitations:'Entry count is a byte-accounting ceiling; JS object overhead, eviction, version invalidation and cache TTL not benchmarked. SQL exact COUNT must not be truncated to 2000 records.'};
 result.environment.peakObservedProcessRssBytes=Math.max(...rss,process.memoryUsage().rss);
 result.limits=['No production/Supabase HTTP, network, persistent I/O, cgroup or concurrent DB clients measured.','PGlite timings are single-process WASM timings, not a PostgreSQL server SLA.','RLS uses synthetic auth.uid and SELECT owner policies matching ownership semantics; no complete production auth/migration chain.','Existing library RPC uses ANY tag semantics and direct collection IDs. ALL tags, keyset and descendant expansion are design SQL only.','Query rewrite is a fixed human-supplied bilingual dictionary, not measured model translation or general multilingual recall.','Candidate scan/return/cache numbers are conservative caps, not throughput/capacity claims.','EXPLAIN of scalar SQL RPC shows outer Result only; direct SQL probes provide inner access-plan evidence.'];
 result.completed=true;
 await mkdir(new URL('../docs/fixtures/',import.meta.url),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({output:fileURLToPath(output),oracles:result.oracles.length,measurements:result.measurements.length,recall:result.recall,peakObservedProcessRssBytes:result.environment.peakObservedProcessRssBytes},null,2));
}finally{await db.close();}
