import assert from "node:assert/strict";
import { it } from "node:test";
import { runMetadataJob } from "../../server/library/worker.mjs";

const base = {id:"doc",user_id:"owner",title:"download",authors:[],metadata_sources:{title:{source:"filename",locked:false}},metadata_revision:0,metadata_state:{status:"running",jobId:"job"}};
const header = {title:"A Synthetic Paper Title",authors:["Alice Example"],pages:["A Synthetic Paper Title\nAlice Example\n2024\nAbstract This is a long enough synthetic document header for extracting metadata."]};
function harness({enabled=true,conflict=false,deleted=false,settingsError=false,stale=false}={}) {
  let fresh=structuredClone(base); let calls=0; let saves=[];
  if(stale) fresh.metadata_state.jobId="new-job";
  const client={
    from(table) {
      const filters={};
      const query={select(){return query;},eq(key,value){filters[key]=value;return query;},is(){return query;},
        async maybeSingle(){
          assert.equal(filters.user_id,"owner");
          return table==="user_settings"?{data:{library_metadata_ai_enabled:enabled},error:settingsError?Error():null}
            :{data:deleted?null:fresh,error:null};
        }};
      return query;
    },
    async rpc(name,payload) {
      assert.equal(name,"finish_document_metadata_job");
      saves.push(payload);
      if(conflict && saves.length===1) {
        fresh={...fresh,title:"Concurrent manual edit",metadata_revision:1,metadata_sources:{title:{source:"user",locked:true}}};
        return {data:false};
      }
      return {data:true};
    },
  };
  return {client,extractHeader:async()=>header,doiLookup:async()=>null,arxivLookup:async()=>null,
    complete:async()=>{calls++;return {content:JSON.stringify({publication_year:{value:2024,evidence:"2024"}})};},
    result:()=>({calls,saves})};
}
it("re-reads the AI opt-out immediately before model use",async()=>{
  const h=harness({enabled:false});await runMetadataJob(base,h);
  assert.equal(h.result().calls,0); assert.equal(h.result().saves[0].p_patch.title,header.title);
});
it("fails closed for AI when settings cannot be read, retaining local fields",async()=>{
  const h=harness({settingsError:true});await runMetadataJob(base,h);
  assert.equal(h.result().calls,0);assert.deepEqual(h.result().saves[0].p_state.warnings,["settings_unavailable"]);
});
it("re-merges after a concurrent edit without charging for another inference",async()=>{
  const h=harness({conflict:true});await runMetadataJob(base,h);
  assert.equal(h.result().calls,1);assert.equal(h.result().saves.length,2);
  assert.equal(h.result().saves[1].p_revision,1);assert.equal(h.result().saves[1].p_patch.title,undefined);
  assert.equal(h.result().saves[1].p_state.suggestions.title.value,header.title);
});
it("drops results after deletion or replacement of the job lease",async()=>{
  for(const options of [{deleted:true},{stale:true}]) {const h=harness(options);await runMetadataJob(base,h);assert.equal(h.result().saves.length,0);}
});
it("persists a retryable error without raw document or provider diagnostics",async()=>{
  const h=harness();h.extractHeader=async()=>{throw new Error("private raw contents");};await runMetadataJob(base,h);
  assert.equal(h.result().saves[0].p_state.status,"failed");assert.equal(h.result().saves[0].p_state.error,"read_failed");
  assert.equal(h.result().calls,0);
});
