import { getSupabaseAccessToken, requireSupabaseClient } from '../../auth/supabaseClient';
import { decodeDocumentPart, sealDocumentManifest, getPartCoverage, PART_LIMITS, type DocumentManifest } from '../../../shared/qaDocumentParts.mjs';
import { resolveMappedNodeLocation, type DocumentRegion, type DocumentLocation, type NodeMapping } from '../../../shared/qaDocumentArtifact.mjs';
import { sha256Text } from '../../../shared/qaDocumentBuilder.mjs';
import { getPublishedDocumentArtifact, type PublishedArtifact } from './preparationApi';
import type { QaCitation, QaRetrievedEvidence, QaArtifactLocator } from '../../types/domain';
type Source = QaCitation | QaRetrievedEvidence;
const cache = new Map<string,{value:unknown;bytes:number;userId:string}>(), pending = new Map<string,Promise<unknown>>();
let bytes=0; const generations=new Map<string,number>();
const keyFor=(userId:string,doc:string,revision:string,part:string)=>JSON.stringify([userId,doc,revision,part]);
async function account(expected?:string) {
 const session=(await requireSupabaseClient().auth.getSession()).data.session;
 if(!session||expected&&session.user.id!==expected)throw new DOMException('Account changed.','AbortError');return session.user.id;
}
export function clearArtifactLocations(userId:string) {
 prefetchQueue.length=0;prefetched.clear();
 generations.set(userId,(generations.get(userId)??0)+1);
 for(const [key,entry] of cache)if(entry.userId===userId){cache.delete(key);bytes-=entry.bytes;}
}
async function cached<T>(key:string,userId:string,load:()=>Promise<{value:T;bytes:number}>):Promise<T>{
 const hit=cache.get(key);if(hit){cache.delete(key);cache.set(key,hit);return hit.value as T;}
 if(pending.has(key))return pending.get(key) as Promise<T>;
 if(pending.size>=32)throw new Error('Document location downloads are busy.');
 const generation=generations.get(userId)??0;
 const work=(async()=>{const loaded=await load();await account(userId);
  if((generations.get(userId)??0)===generation&&loaded.bytes<=24*1024*1024){
   while(cache.size>=128||bytes+loaded.bytes>24*1024*1024){const oldest=cache.keys().next().value as string|undefined;if(!oldest)break;bytes-=cache.get(oldest)!.bytes;cache.delete(oldest);}
   cache.set(key,{...loaded,userId});bytes+=loaded.bytes;
  }return loaded.value;
 })();pending.set(key,work);try{return await work;}finally{pending.delete(key);}
}
async function download(userId:string,bucket:string,path:string,maxBytes:number):Promise<Blob>{
 await account(userId);const token=await getSupabaseAccessToken();
 const url=`${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}?access=${crypto.randomUUID()}`;
 const response=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(45000),headers:{Authorization:`Bearer ${token}`,apikey:import.meta.env.VITE_SUPABASE_ANON_KEY}});
 if(!response.ok||!response.body)throw new Error('无法读取这次引用的文档版本。');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('Document transfer limit exceeded.');chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 await account(userId);return new Blob(chunks);
}
async function published(userId:string,source:Source){
 if(source.sourceKind!=='document_artifact')throw new Error('Not an artifact citation.');
 return cached(keyFor(userId,source.cloudDocumentId,source.sourceVersion,'published'),userId,async()=>{
  const locator=source.sourceLocator;
  const prefix=`published/${userId}/${source.cloudDocumentId}/${source.sourceVersion}/`;
  // A harness-issued path is only a routing hint. RLS authorizes the private
  // fetch; manifest/part hashes still validate identity. No QA round trip is
  // needed to ask for the same path again at first display.
  const routed=locator.manifestPath?.startsWith(prefix) && /^[0-9a-f-]{36}\/manifest\.json$/.test(locator.manifestPath.slice(prefix.length));
  const value:PublishedArtifact=routed ? {state:'ready',revision:source.sourceVersion,manifestSha256:locator.manifestSha256,
    pdfSha256:locator.pdfSha256,manifestPath:locator.manifestPath!,pdfPath:'',pageCount:0,bucket:'qa-document-artifacts'}
    : await getPublishedDocumentArtifact(source.cloudDocumentId,source.sourceVersion,AbortSignal.timeout(15000));
  if(value.manifestSha256!==locator.manifestSha256||value.pdfSha256!==locator.pdfSha256)throw new Error('引用版本不匹配。');
  return {value,bytes:2048};
 });
}
async function manifest(userId:string,source:Source,record:PublishedArtifact){
 return cached<DocumentManifest>(keyFor(userId,source.cloudDocumentId,record.revision,'manifest'),userId,async()=>{
  const blob=await download(userId,record.bucket,record.manifestPath,PART_LIMITS.maxManifestBytes),text=await blob.text();
  if(await sha256Text(text)!==record.manifestSha256)throw new Error('Document manifest mismatch.');
  const value=await sealDocumentManifest(JSON.parse(text));if(value.revision!==record.revision)throw new Error('Document revision mismatch.');return {value,bytes:blob.size*4};
 });
}
async function resolve(source:Source,userId:string):Promise<DocumentLocation>{
 if(source.sourceKind!=='document_artifact')throw new Error('Not an artifact citation.');
 const record=await published(userId,source),body=await manifest(userId,source,record),locator:QaArtifactLocator=source.sourceLocator;
 const node=body.nodes.find(n=>n.id===locator.nodeId);
 if(!node||locator.range[0]<0||locator.range[1]>node.textLength||locator.range[1]<=locator.range[0])throw new Error('Invalid citation interval.');
 const regions=new Map<string,DocumentRegion>(),segments:NodeMapping['segments']=[];let text='';
 const ids=[...node.readingParts,...node.locationParts].filter(id=>{const range=getPartCoverage(body,id,node.id)!;return range[1]>locator.range[0]&&range[0]<locator.range[1];});
 const loaded = new Map<string, Awaited<ReturnType<typeof decodeDocumentPart>>>();let next=0;
 await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{for(;;){const id=ids[next++];if(!id)return;
  const part=await cached(keyFor(userId,source.cloudDocumentId,record.revision,id),userId,async()=>{
   const blob=await download(userId,record.bucket,record.manifestPath.replace(/manifest\.json$/,id+'.json'),body.parts[id].bytes);
   return {value:await decodeDocumentPart(body,id,await blob.text()),bytes:blob.size*4};
  });loaded.set(id,part);
 }}));
 for(const id of ids){const part=loaded.get(id)!,range=getPartCoverage(body,id,node.id)!,item=part.entries.find(e=>e.nodeId===node.id)!;
  if(item.text!==undefined)text+=item.text.slice(Math.max(range[0],locator.range[0])-range[0],Math.min(range[1],locator.range[1])-range[0]);
  else{segments.push(...item.segments!);for(const region of part.regions??[])regions.set(region.id,region);}
 }
 if(text.length!==locator.range[1]-locator.range[0])throw new Error('Citation body is incomplete.');
 return resolveMappedNodeLocation({id:node.id,text:' '.repeat(locator.range[0])+text+' '.repeat(node.textLength-locator.range[1])},
   {nodeId:node.id,segments,pageAnchor:node.pageAnchor},regions,locator.range);
}
export async function locateArtifactSource(source:Source){
 const userId=await account();
 return cached(keyFor(userId,source.cloudDocumentId,source.sourceVersion??'',`resolved:${source.evidenceKey}`),userId,async()=>{
  const value=await resolve(source,userId);return {value,bytes:JSON.stringify(value).length*4};
 });
}
// A bounded queue avoids launching a download for every new streaming source.
const prefetchQueue:Source[]=[];const prefetched=new Set<string>();let active=0;
export function prefetchArtifactSources(sources:QaCitation[]){
 for(const source of sources){if(source.sourceKind!=='document_artifact'||prefetchQueue.length>=32)continue;
  const key=source.id;if(prefetched.has(key))continue;prefetched.add(key);prefetchQueue.push(source);}
 if(prefetched.size>512)prefetched.clear();
 const pump=()=>{while(active<2&&prefetchQueue.length){const next=prefetchQueue.shift()!;active++;void locateArtifactSource(next).catch(()=>{}).finally(()=>{active--;pump();});}};pump();
}
export async function loadArtifactPdf(source:Source){
 const userId=await account();if(source.sourceKind!=='document_artifact')throw new Error('Not an artifact citation.');
 // Recheck retained-version access each time a different PDF is opened. Existing
 // open-document clicks remain local; copied bytes cannot be remotely revoked.
 const record=await getPublishedDocumentArtifact(source.cloudDocumentId,source.sourceVersion,AbortSignal.timeout(15000));
 if(record.pdfSha256!==source.sourceLocator.pdfSha256)throw new Error('引用 PDF 版本不匹配。');
 const blob=await download(userId,record.bucket,record.pdfPath,100*1024*1024);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))).map(x=>x.toString(16).padStart(2,'0')).join('');
 if(digest!==record.pdfSha256)throw new Error('引用 PDF 校验失败。');return new Blob([blob],{type:'application/pdf'});
}
