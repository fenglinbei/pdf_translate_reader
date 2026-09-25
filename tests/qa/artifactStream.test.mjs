import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {handleWorkspaceStream} from '../../server/qa/workspace/stream.mjs';
class Response extends EventEmitter {headersSent=false;writableEnded=false;destroyed=false;output='';writeHead(){this.headersSent=true;}write(t){this.output+=t;return true;}end(){this.writableEnded=true;}}
for(const fault of ['none','commit','terminal'])test(`artifact streaming final durability: ${fault}`,async()=>{
 const response=new Response(),updates=[];let commits=0,calls=0;
 const workspace={ledger:{citation(ref,evidenceId){assert.equal(ref,'R1');return {evidenceId,sourceKind:'document_artifact',cloudDocumentId:'doc',quotedText:'Read evidence'};}},metrics:{returnedChars:20},assertCurrent:async()=>{}};
 const db={createOrReuseQaThread:async()=>({id:'thread'}),listQaMessagesForThread:async()=>[],insertQaMessage:async v=>({...v,id:v.role}),
  updateQaMessage:async v=>{updates.push(v);return v;},commitArtifactAnswer:async({citations,content})=>{commits++;if(fault==='commit')throw new Error('Synthetic save failed');return {message:{content,status:'success'},citations};}};
 const createAdapter=()=>({stream:async({onDelta})=>{calls++;onDelta('Answer [R');onDelta('1].');return {message:{role:'assistant',content:'Answer [R1].'},calls:[]};}});
 const createContext=()=>({events:{modelUsage(){}},modelCall:async(_,fn)=>fn(),setPhase(){},steps:[],terminal:async()=>{if(fault==='terminal')throw new Error('Synthetic log failure');}});
 await handleWorkspaceStream({},response,{id:'alice'},{model:'deepseek-flash',question:'test'},{artifacts:true,workspace,db,createAdapter,createContext});
 assert.equal(calls,1);assert.equal(commits,1);assert(response.output.indexOf('event: citation')<response.output.indexOf('[C1]'));
 if(fault==='commit'){assert(!response.output.includes('event: done'));assert(response.output.includes('event: error'));assert.equal(updates.at(-1).status,'error');assert.equal(updates.at(-1).content,'Answer [C1].');}
 else{assert(response.output.includes('event: done'));assert.equal(updates.length,0);}
});
