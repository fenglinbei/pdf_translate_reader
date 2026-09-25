import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentArtifact } from '../../shared/qaDocumentBuilder.mjs';
import { packDocumentArtifact } from '../../shared/qaDocumentParts.mjs';
import { createArtifactLoader } from '../../server/qa/documentArtifacts/loader.mjs';
import { createPublishedReferences } from '../../server/qa/documentArtifacts/publishedReferences.mjs';
import { createArtifactWorkspace, ARTIFACT_TOOLS } from '../../server/qa/documentArtifacts/tools.mjs';
import { createCitationStream } from '../../server/qa/documentArtifacts/citationStream.mjs';
import { createArtifactProtocol } from '../../server/qa/documentArtifacts/protocol.mjs';
import { runWorkspaceAgent } from '../../server/qa/workspace/runtime.mjs';
async function fixture() {
 const text='The observed relation agreement is moderate. Calibration remains weak.';
 const {artifact}=await buildDocumentArtifact({pdfSha256:'a'.repeat(64),mmd:'# Results\n\n'+text+'\n\nA second independent paragraph describes evaluation results.',pages:[{pageIndex:0,lines:[{lineIndex:0,text}]}]});
 const packed=await packDocumentArtifact(artifact),files=new Map(packed.files.map(f=>[f.id,f.text]));let checks=0,loads=[];
 const loader=createArtifactLoader({authorize:async()=>{checks++;},loadText:async s=>{loads.push(s.partId);return s.partId==='manifest'?packed.manifestText:files.get(s.partId);}});
 const load=async scope=>({...await loader.open({...scope,revision:artifact.revision,manifestSha256:packed.manifestSha256}),title:'Synthetic',pdfFingerprint:'fingerprint'});
 const reader=await load({userId:'alice',documentId:'doc'});
 return {reader,artifact,load,get checks(){return checks;},loads};
}
test('only returned ranges become citable; stable parent/sentence handles have pinned user/run scope',async()=>{
 const f=await fixture(),receipt=await f.reader.read(f.artifact.nodes.find(n=>n.kind==='paragraph').id),ledger=createPublishedReferences({userId:'alice',runId:'run'});
 const [item]=ledger.registerBatch([{receipt,document:'D1',title:'Synthetic'}]);assert.equal(item.ref,'R1');assert.equal(item.text,undefined);assert.equal(item.sentences.length,2);
 assert.equal(ledger.citation('R1.2','C1').quotedText,'Calibration remains weak.');
 assert.equal(ledger.citation('R1','C1').sourceLocator.manifestSha256.length,64);
 assert.throws(()=>ledger.resolve('R2'),{code:'UNKNOWN_READ_REFERENCE'});
 assert.throws(()=>ledger.resolve('R1',{userId:'alice',runId:'old'}),{code:'READ_SCOPE_MISMATCH'});
 assert.throws(()=>ledger.registerBatch([{receipt:structuredClone(receipt)}]),{code:'READ_SCOPE_MISMATCH'});
 assert.equal(ledger.registerBatch([{receipt,document:'D1'}])[0].ref,'R1');assert.equal(ledger.metrics.returnedChars,receipt.text.length*2);
});
test('outline grants no evidence; search receipts expose only returned snippets and read can expand them',async()=>{
 const f=await fixture(),workspace=createArtifactWorkspace({userId:'alice',activeDocumentId:'doc',load:f.load});
 assert.deepEqual(ARTIFACT_TOOLS.map(t=>t.function.name),['discover_documents','document_outline','search_document','read_document']);
 const outline=await workspace.execute('document_outline',{document:'current'});assert.equal(outline.sections[0].title,'Results');assert.equal(workspace.metrics.returnedChars,0);
 const checks=f.checks;
 const found=await workspace.execute('search_document',{documents:['current'],queries:['moderate']});assert.equal(found.results[0].evidence[0].ref,'R1');assert.equal(f.checks-checks,2);
 assert.equal(f.loads.some(id=>id.startsWith('l_')),false);
 const read=await workspace.execute('read_document',{source:'R1'});assert.equal(read.evidence[0].ref,'R1');assert.equal(read.hasMore,false);
});
test('streamed markers never appear half-rendered and metadata arrives first; code/math keep literal text',()=>{
 const events=[],ledger={citation:(ref,evidenceId)=>{assert(['R1','R1.2'].includes(ref));return {evidenceId,quotedText:ref};}};
 const text='Fact [R1.2]. Again [R1.2]. `literal [R1]` $[R1]$\n```txt\n[R1]\n```\nThen [R1].';
 for(let width=1;width<12;width++){
  events.length=0;const stream=createCitationStream({ledger,messageId:'m',attemptId:1,onDelta:t=>events.push(['delta',t]),onCitations:c=>events.push(['citations',c.map(v=>v.evidenceId)])});
  for(let i=0;i<text.length;i+=width)stream.push(text.slice(i,i+width));const result=stream.finish();
  assert.equal(result.answer,'Fact [C1]. Again [C1]. `literal [R1]` $[R1]$\n```txt\n[R1]\n```\nThen [C2].');assert.equal(result.citations.length,2);
  const metadata=events.findIndex(e=>e[0]==='citations');const marker=events.findIndex(e=>e[0]==='delta'&&e[1].includes('[C1]'));assert(metadata<marker);
 }
});
test('unknown and incomplete handles are withheld; escaped literals do not grant citations',()=>{
 const events=[],stream=createCitationStream({ledger:{citation(){throw new Error('unknown');}},messageId:'m',attemptId:1,onDelta:t=>events.push(t),onCitations:()=>assert.fail()});
 stream.push('x [R90] y \\[R1] z [R');const result=stream.finish();assert.equal(result.answer,'x  y \\[R1] z ');assert.equal(result.rejected.length,2);
});
test('ordinary questions finish with zero tools; document answers directly cite read handles in two model turns',async()=>{
 const f=await fixture();
 for(const ordinary of [true,false]){
  const workspace=createArtifactWorkspace({userId:'alice',activeDocumentId:'doc',load:f.load}),events=[];
  const protocol=createArtifactProtocol({workspace,messageId:'m',onCitations:c=>events.push(c)});let calls=0;
  const adapter={async stream({messages,tools,onDelta}){calls++;assert.equal(tools.length,4);assert(!messages[0].content.includes('cite_sources'));
    if(!ordinary&&calls===1)return {message:{role:'assistant',content:'',tool_calls:[{id:'t1',type:'function',function:{name:'read_document',arguments:'{"document":"current"}'}}]},calls:[{id:'t1',name:'read_document',arguments:'{"document":"current"}'}]};
    const content=ordinary?'我是本次配置的模型。':'Agreement is moderate [R1.1].';onDelta(content);return {message:{role:'assistant',content},calls:[]};}};
  const context={modelCall:async(_,fn)=>fn(),events:{modelUsage(){},toolStart(){},tool:async()=>{},commentaryDelta(){},flushCommentary:async()=>{}}};
  const result=await runWorkspaceAgent({adapter,workspace,protocol,context,model:'deepseek-flash',question:ordinary?'你是什么模型':'论文结论是什么',activeDocumentId:'doc',userId:'alice'});
  assert.equal(result.metrics.toolCalls,ordinary?0:1);assert.equal(calls,ordinary?1:2);assert(result.verified.valid);assert.equal(result.verified.citations.length,ordinary?0:1);
 }
});
