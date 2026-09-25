const failure=(code,message,statusCode=429)=>Object.assign(new Error(message),{code,statusCode});
// One outstanding request per user, FIFO across users, bounded process-wide
// admission. Deployments with several QA processes need a shared coordinator.
export function createStreamAdmission({maxActive=2,maxQueued=8,waitMs=120000}={}){
 if(!Number.isInteger(maxActive)||maxActive<1||maxActive>32||!Number.isInteger(maxQueued)||maxQueued<0||maxQueued>128||!Number.isInteger(waitMs)||waitMs<1||waitMs>180000)throw new Error('Invalid QA admission limits.');
 let active=0,highWater=0;const users=new Set(),queue=[];
 function pump(){while(active<maxActive&&queue.length){const item=queue.shift();item.start();}}
 function acquire(userId,signal){
  if(signal?.aborted)return Promise.reject(signal.reason);
  if(users.has(userId))return Promise.reject(failure('qa_user_busy','你已有一个正在处理或排队的问答，请完成或取消后继续。'));
  if(active>=maxActive&&queue.length>=maxQueued)return Promise.reject(failure('qa_busy','问答服务的等待队列已满，请稍后重试。'));
  users.add(userId);
  return new Promise((resolve,reject)=>{
   let timer,started=false,released=false;
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
   const remove=()=>{const index=queue.indexOf(item);if(index>=0)queue.splice(index,1);};
   const cancel=()=>{if(started)return;remove();cleanup();users.delete(userId);reject(signal.reason);};
   const item={start(){if(started)return;started=true;cleanup();active++;highWater=Math.max(highWater,active);let once=false;
    resolve({release(){if(once)return;once=true;active--;users.delete(userId);pump();}});
   }};
   if(active<maxActive)item.start();
   else {queue.push(item);signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(()=>{
     if(started||released)return;released=true;remove();cleanup();users.delete(userId);reject(failure('qa_queue_timeout','等待问答服务超时，请稍后重试。',503));
    },waitMs);timer.unref?.();}
  });
 }
 return {acquire,get metrics(){return {active,queued:queue.length,users:users.size,highWater,maxActive,maxQueued};}};
}
