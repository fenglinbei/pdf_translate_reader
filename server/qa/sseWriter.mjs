export function createSseWriter(response,{onFailure=()=>{},maxBufferedBytes=1024*1024,stallMs=30000}={}){
 const queue=[];let queuedBytes=0,blocked=false,failed=false,ending=false,timer,completion;
 function fail(){if(failed)return;failed=true;clearTimeout(timer);queue.length=0;queuedBytes=0;
  const error=Object.assign(new Error('连接接收过慢，本次问答已停止。'),{code:'QA_SLOW_CLIENT'});onFailure(error);response.destroy?.();completion?.();}
 function arm(){clearTimeout(timer);timer=setTimeout(fail,stallMs);timer.unref?.();}
 function drain(){if(failed)return;blocked=false;clearTimeout(timer);
  while(queue.length&&!blocked){const item=queue.shift();queuedBytes-=Buffer.byteLength(item);blocked=response.write(item)===false;}
  if(blocked)arm();else if(ending){response.end();completion?.();}
 }
 response.on('drain',drain);response.once('close',()=>{clearTimeout(timer);queue.length=0;queuedBytes=0;completion?.();});
 function write(text){if(failed||response.destroyed||response.writableEnded)return;
  const size=Buffer.byteLength(text);if(size+queuedBytes+(response.writableLength??0)>maxBufferedBytes){fail();return;}
  if(blocked){queue.push(text);queuedBytes+=size;return;}
  blocked=response.write(text)===false;if(blocked)arm();
 }
 return {emit(event,payload){write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);},heartbeat(){write(': keep-alive\n\n');},
  async end(){ending=true;if(failed||response.destroyed||response.writableEnded)return;if(!blocked&&!queue.length){response.end();return;}await new Promise(resolve=>{completion=resolve;});},
  get metrics(){return {queuedBytes,blocked,failed};}};
}
