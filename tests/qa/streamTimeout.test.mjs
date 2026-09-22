import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { createServer } from "vite";

let vite, client;
const originalFetch=globalThis.fetch;
const originalWindow=globalThis.window;
before(async()=>{
  vite=await createServer({appType:"custom",configFile:false,logLevel:"silent",server:{middlewareMode:true},plugins:[{
    name:"qa-stream-test-dependencies",enforce:"pre",
    resolveId(id){if(id.endsWith("auth/supabaseClient")) return "\0test-auth";if(id.endsWith("config/projectConfig")) return "\0test-config";},
    load(id){if(id==="\0test-auth") return 'export async function getSupabaseAccessToken(){return "test-token";}';if(id==="\0test-config") return 'export const PROJECT_CONFIG={api:{qaAnswerTimeoutMs:180000}};';},
  }]});
  client=await vite.ssrLoadModule("/src/qa/qaClient.ts");
});
after(async()=>{await vite?.close();});
afterEach(()=>{globalThis.fetch=originalFetch;if(originalWindow===undefined) delete globalThis.window;else globalThis.window=originalWindow;});
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function start(t,parentSignal){
  t.mock.timers.enable({apis:["setTimeout"]});
  globalThis.window=globalThis;
  let streamController, signal;
  const encoder=new TextEncoder();
  globalThis.fetch=async(_url,init)=>{
    signal=init.signal;
    return new Response(new ReadableStream({start(controller){streamController=controller;signal.addEventListener("abort",()=>controller.error(new DOMException("Aborted","AbortError")),{once:true});}}));
  };
  const promise=client.streamQaAnswer({model:"glm-5.3",question:"test",activeDocumentId:"doc"},{onDelta(){}},parentSignal);
  return {promise,get signal(){return signal;},write(text){streamController.enqueue(encoder.encode(text));},close(){streamController.close();}};
}

test("QA heartbeats extend an active stream beyond the previous fixed timeout",async t=>{
  const stream=start(t);await flush();
  for(let i=0;i<3;i++){
    t.mock.timers.tick(170000);
    stream.write(": keep-alive\n\n");await flush();
    assert.equal(stream.signal.aborted,false);
  }
  stream.write('event: delta\ndata: {"text":"answer"}\n\n');
  stream.close();await stream.promise;
  t.mock.timers.tick(600000);
  assert.equal(stream.signal.aborted,false);
});

test("silent QA streams still time out",async t=>{
  const stream=start(t);const rejected=assert.rejects(stream.promise,/QA answer timed out/);await flush();
  t.mock.timers.tick(180000);await rejected;
  assert.equal(stream.signal.aborted,true);
});

test("heartbeats cannot extend QA beyond the ten-minute total cap",async t=>{
  const stream=start(t);const rejected=assert.rejects(stream.promise,/QA answer timed out/);await flush();
  for(let i=0;i<3;i++){t.mock.timers.tick(170000);stream.write(": keep-alive\n\n");await flush();}
  t.mock.timers.tick(90000);await rejected;
});

test("caller cancellation aborts an active QA request",async t=>{
  const parent=new AbortController();const stream=start(t,parent.signal);
  const rejected=assert.rejects(stream.promise,error=>error.name==="AbortError");await flush();
  parent.abort();await rejected;
  assert.equal(stream.signal.aborted,true);
});
