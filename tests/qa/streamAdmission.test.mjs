import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter,once} from 'node:events';
import {createStreamAdmission} from '../../server/qa/streamAdmission.mjs';import {createSseWriter} from '../../server/qa/sseWriter.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('ten distinct users finish through two slots and eight bounded FIFO waits',async()=>{
 const scheduler=createStreamAdmission(),started=[],finished=[];
 await Promise.all(Array.from({length:10},async(_,i)=>{const lease=await scheduler.acquire(`u${i}`);started.push(i);await delay(8);finished.push(i);lease.release();lease.release();}));
 assert.deepEqual(started,Array.from({length:10},(_,i)=>i));assert.equal(finished.length,10);assert.deepEqual(scheduler.metrics,{active:0,queued:0,users:0,highWater:2,maxActive:2,maxQueued:8});
});
test('one user cannot fill the queue; cancelled and timed out waiters release all bookkeeping',async()=>{
 const s=createStreamAdmission({maxActive:1,maxQueued:1,waitMs:20}),a=await s.acquire('a');
 await assert.rejects(s.acquire('a'),{code:'qa_user_busy'});
 const abort=new AbortController(),pending=s.acquire('b',abort.signal),reject=assert.rejects(pending,e=>e.name==='AbortError');
 await assert.rejects(s.acquire('c'),{code:'qa_busy'});abort.abort();await reject;
 const timeout=s.acquire('c');const timeoutCheck=assert.rejects(timeout,{code:'qa_queue_timeout'});await delay(30);await timeoutCheck;
 a.release();assert.equal(s.metrics.users,0);assert.equal(s.metrics.queued,0);
});
class Response extends EventEmitter{constructor(){super();this.parts=[];this.blocked=true;this.writableLength=0;}write(t){this.parts.push(t);return !this.blocked;}end(){this.writableEnded=true;}destroy(){this.destroyed=true;this.emit('close');}}
test('SSE backpressure preserves metadata-before-marker order and waits before ending',async()=>{
 const res=new Response(),writer=createSseWriter(res);writer.emit('citation',{citations:['C1']});writer.emit('delta',{text:'[C1]'});
 assert.equal(res.parts.length,1);const done=writer.end();assert.equal(res.writableEnded,undefined);res.blocked=false;res.emit('drain');await done;
 assert.match(res.parts[0],/citation/);assert.match(res.parts[1],/delta/);assert.equal(res.writableEnded,true);
});
test('slow SSE connections have finite bytes and deadline and abort upstream work',async()=>{
 const res=new Response(),errors=[],writer=createSseWriter(res,{maxBufferedBytes:100,stallMs:15,onFailure:e=>errors.push(e)});
 writer.emit('delta',{text:'a'});writer.emit('delta',{text:'x'.repeat(100)});assert.equal(errors[0].code,'QA_SLOW_CLIENT');assert.equal(res.destroyed,true);
 const stalled=new Response(),w=createSseWriter(stalled,{stallMs:15,onFailure:e=>errors.push(e)});w.heartbeat();await delay(25);assert.equal(stalled.destroyed,true);assert.equal(w.metrics.queuedBytes,0);
});
