import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { requireCondition } from '../documents/errors.mjs';
import { discoverWorkspaceDocuments } from '../workspace/repository.mjs';
import { openCurrentArtifact, requireArtifactDocument, requireArtifactDocuments } from './repository.mjs';
import { createPublishedReferences } from './publishedReferences.mjs';
import { sliceArtifactReceipt } from './loader.mjs';

const str = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });
const object = properties => ({ type: 'object', properties, additionalProperties: false });
const page = { type: 'integer', minimum: 1, maximum: 10000 };
const definitions = [
  { name: 'discover_documents', description: '按需查找工作区文档。省略 query 或传空字符串列出最近文档；非空 query 匹配标题、文件名和已有摘要。返回当前打开的文章标记。摘要仅帮助选文档，不能作为已读正文引用。普通交流无需调用。', parameters: object({ query: { type:'string',maxLength:200 }, archived: { type: 'string', enum: ['all','only','exclude'] }, cursor: str() }) },
  { name: 'document_outline', description: '查看文章的章节目录。document 使用发现结果的文档编号，current 表示当前打开的文章。目录用于选择章节，不代表读过正文。续页只传 cursor。', parameters: object({ document: str(), cursor: str() }) },
  { name: 'search_document', description: '在一至四篇文章中按原文词语查找，queries 可提供同义词。返回实际读到的片段及 R 来源编号，可直接引用或用 read_document 补读整段。未命中不证明全文不存在；hasMore 表示还有待查部分，续查只传 cursor。', parameters: object({ documents: { type:'array',minItems:1,maxItems:4,uniqueItems:true,items:str() },queries:{type:'array',minItems:1,maxItems:4,items:str(200)},cursor:str() }) },
  { name: 'read_document', description: '阅读文章正文，可选 section 章节或 pageStart/pageEnd 页范围（最多四页）；只传 document 从开头阅读。只传 source 可补读该 R 来源所在的完整段落/表格；只传 cursor 续读。返回 ref 是可直接用于答案的 [R1] 引用，sentences 中的 [R1.1] 可选择关键句；引用整段用父 ref。不用抄写原文或额外标记引用。hasMore 为 true 时尚未读完。', parameters: object({ document:str(),section:str(),pageStart:page,pageEnd:page,source:{type:'string',pattern:'^R[1-9][0-9]*(\\.[1-9][0-9]*)?$'},cursor:str() }) },
];
export const ARTIFACT_TOOLS = Object.freeze(definitions.map(fn => ({ type:'function',function:fn })));
const ajv = new Ajv({ strict:true,allErrors:true });
const validators = new Map(definitions.map(fn => [fn.name,ajv.compile(fn.parameters)]));
export function validateArtifactTool(name,input) {
  const check = validators.get(name); requireCondition(check,'UNKNOWN_TOOL','请使用提供的问答工具。');
  requireCondition(check(input),'INVALID_TOOL_ARGUMENTS','请检查工具参数。',{details:check.errors?.map(e=>({path:e.instancePath,reason:e.message})).slice(0,8)});
  if(input.cursor) requireCondition(Object.keys(input).length===1,'INVALID_TOOL_ARGUMENTS','续读只需传 cursor。');
}
async function loadPublished(scope,options) {
  const reader = await openCurrentArtifact(scope,options), document = await requireArtifactDocument(scope);
  return { ...reader, title:document.title || document.display_file_name || '文档', pdfFingerprint:document.pdf_fingerprint };
}
export function createArtifactWorkspace({ userId,runId = randomUUID(),activeDocumentId,signal,load = loadPublished,discover = discoverWorkspaceDocuments,authorizeDocuments }) {
  const ids=new Map(), documents=new Map(), readers=new Map(), cursors=new Map();
  const ledger=createPublishedReferences({userId,runId}); let discoveryCalls=0, scanChars=0;
  function docRef(id) { if(!ids.has(id)){const ref=`D${ids.size+1}`;ids.set(id,ref);documents.set(ref,id);}return ids.get(id); }
  if(activeDocumentId)documents.set('current',activeDocumentId);
  async function reader(ref) {
    const id=documents.get(ref);requireCondition(id,'UNKNOWN_DOCUMENT','请使用发现结果的文档编号；current 表示当前文章。');
    if(!readers.has(id)) {
      requireCondition(readers.size<8,'DOCUMENT_BUDGET_EXHAUSTED','本次查阅文档数量达到上限。');
      const value=await load({userId,documentId:id},{signal});
      const nodes=value.snapshot.manifest.nodes, sections=new Map(nodes.filter(n=>n.kind==='section').map((n,i)=>[`S${i+1}`,n]));
      const bodyNodes=nodes.filter(n=>n.kind!=='section');
      readers.set(id,{...value,id,document:docRef(id),nodes,sections,bodyNodes,bodyIndexes:new Map(bodyNodes.map((n,i)=>[n.id,i]))});
    }
    return readers.get(id);
  }
  function continuation(name,args) { requireCondition(cursors.size<64,'TOOL_BUDGET_EXHAUSTED','续读数量达到上限。');const id=randomUUID();cursors.set(id,{name,args});return id; }
  function emitRead(r,receipts) { return receipts.length ? ledger.registerBatch(receipts.map(receipt=>({receipt,document:r.document,title:r.title,pdfFingerprint:r.pdfFingerprint}))) : []; }
  function selectedNodes(r,args) {
    let nodes=r.nodes.filter(n=>n.kind!=='section');
    if(args.source) { const source=ledger.resolve(args.source);return nodes.filter(n=>n.id===source.receipt.nodeId); }
    if(args.section) {
      const section=r.sections.get(args.section);requireCondition(section,'UNKNOWN_SECTION','请使用目录返回的章节编号。');
      const byId=new Map(r.nodes.map(n=>[n.id,n]));nodes=nodes.filter(node=>{let parent=node.parentId;while(parent){if(parent===section.id)return true;parent=byId.get(parent)?.parentId;}return false;});
    }
    if(args.pageStart) nodes=nodes.filter(n=>n.pageSlices.some(s=>s.pageNumber>=args.pageStart&&s.pageNumber<=args.pageEnd)||n.pageAnchor>=args.pageStart&&n.pageAnchor<=args.pageEnd);
    return nodes;
  }
  async function read(args) {
    const r=await reader(args.document),nodes=selectedNodes(r,args);let index=args.index??0,offset=args.offset??0,budget=Math.min(14000,96000-ledger.metrics.returnedChars);const batch=[];
    requireCondition(budget>0,'READ_BUDGET_EXHAUSTED','本次已读资料达到上限，请依据现有资料回答。');
    while(index<nodes.length&&budget>1&&batch.length<32){const node=nodes[index],size=Math.min(budget,node.textLength-offset);batch.push({nodeId:node.id,start:offset,maxChars:size});budget-=size;offset+=size;if(offset===node.textLength){index++;offset=0;}}
    const receipts=batch.length?await r.readBatch(batch):[];
    // A split surrogate can shorten the last receipt by one UTF-16 unit.
    if(receipts.length){const last=receipts.at(-1),lastNode=nodes.findIndex(n=>n.id===last.nodeId);index=last.range[1]===nodes[lastNode].textLength?lastNode+1:lastNode;offset=index===lastNode?last.range[1]:0;}
    const hasMore=index<nodes.length;
    return {document:r.document,evidence:emitRead(r,receipts),hasMore,...(hasMore?{cursor:continuation('read_document',{...args,index,offset})}:{})};
  }
  async function search(args) {
    requireCondition(args.documents?.length&&args.queries?.length,'INVALID_TOOL_ARGUMENTS','请提供 documents 和 queries，或只传 cursor。');
    const escaped=q=>q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const patterns=args.queries.map(q=>new RegExp(escaped(q),'iu'));
    let docIndex=args.docIndex??0,index=args.index??0,offset=args.offset??0,scanned=0;const results=[];
    while(docIndex<args.documents.length&&scanned<128000&&scanChars<1000000&&results.reduce((s,r)=>s+r.evidence.length,0)<6){
      const r=await reader(args.documents[docIndex]),nodes=r.bodyNodes,batch=[];
      let nextIndex=index,nextOffset=offset,requested=0;
      while(nextIndex<nodes.length&&batch.length<256){const node=nodes[nextIndex],size=Math.min(16000,node.textLength-nextOffset,128000-scanned-requested,1000000-scanChars-requested);
        if(size<1)break;batch.push({nodeId:node.id,start:nextOffset,maxChars:size});requested+=size;nextOffset+=size;if(nextOffset===node.textLength){nextIndex++;nextOffset=0;}else break;}
      if(!batch.length){if(index>=nodes.length){docIndex++;index=0;offset=0;continue;}break;}
      const receipts=await r.readBatch(batch),snippets=[];
      for(const receipt of receipts){
        scanned+=receipt.text.length;scanChars+=receipt.text.length;
        const matches=patterns.flatMap(p=>{const m=p.exec(receipt.text);return m?[m]:[];}).sort((a,b)=>a.index-b.index);
        if(matches.length&&results.reduce((s,r)=>s+r.evidence.length,0)+snippets.length>=6)break;
        index=r.bodyIndexes.get(receipt.nodeId);offset=receipt.range[1];if(offset===nodes[index].textLength){index++;offset=0;}
        if(matches.length){const match=matches[0];let from=Math.max(0,match.index-240),to=Math.min(receipt.text.length,match.index+match[0].length+360);
          if(/[\uDC00-\uDFFF]/.test(receipt.text[from]??''))from--;if(/[\uDC00-\uDFFF]/.test(receipt.text[to]??''))to--;
          snippets.push(sliceArtifactReceipt(receipt,receipt.range[0]+from,receipt.range[0]+to));
        }
      }
      if(snippets.length)results.push({document:r.document,evidence:emitRead(r,snippets)});
      await new Promise(resolve=>setImmediate(resolve));signal?.throwIfAborted();
    }
    const hasMore=docIndex<args.documents.length&&scanChars<1000000;
    return {results,hasMore,scanLimitReached:scanChars>=1000000,...(hasMore?{cursor:continuation('search_document',{...args,docIndex,index,offset})}:{})};
  }
  async function execute(name,input) {
    signal?.throwIfAborted();validateArtifactTool(name,input);let args=input;
    if(input.cursor){const saved=cursors.get(input.cursor);requireCondition(saved?.name===name,'INVALID_CURSOR','请使用本次该工具返回的 cursor。');args=saved.args;}
    if(name==='discover_documents'){
      discoveryCalls++;const data=await discover({userId,currentDocumentId:activeDocumentId,query:args.query,archived:args.archived,offset:args.offset??0,limit:10});
      const project=({id,...card})=>({document:docRef(id),...card});
      return {documents:data.documents.map(project),currentDocument:data.currentDocument?project(data.currentDocument):null,hasMore:data.hasMore,...(data.hasMore?{cursor:continuation(name,{...args,offset:data.nextOffset})}:{})};
    }
    if(name==='document_outline'){
      requireCondition(args.document,'INVALID_TOOL_ARGUMENTS','请提供 document。');const r=await reader(args.document),offset=args.offset??0,sections=[...r.sections];
      const items=sections.slice(offset,offset+60).map(([section,n])=>({section,title:n.title,level:n.level,...(n.pageAnchor?{page:n.pageAnchor}:{})}));
      return {document:r.document,sections:items,hasMore:offset+60<sections.length,...(offset+60<sections.length?{cursor:continuation(name,{...args,offset:offset+60})}:{})};
    }
    if(name==='search_document')return search(args);
    if(args.source){requireCondition(input.cursor||Object.keys(args).length===1,'INVALID_TOOL_ARGUMENTS','补读来源只需 source。');args={...args,document:ledger.resolve(args.source).document};}
    requireCondition(args.document&&!(args.section&&(args.pageStart||args.pageEnd))&&Boolean(args.pageStart)===Boolean(args.pageEnd),'INVALID_TOOL_ARGUMENTS','请提供 document，可选 section 或完整起止页范围。');
    if(args.pageStart)requireCondition(args.pageEnd>=args.pageStart&&args.pageEnd-args.pageStart<4,'INVALID_TOOL_ARGUMENTS','页范围须为一至四页。');
    return read(args);
  }
  function describeActivity(name,input={},result) {
    const data=result?.ok?result.data:undefined,locations=[];
    for(const group of data?.results??(data?[data]:[])){
      const r=readers.get(documents.get(group.document));
      for(const item of group.evidence??[]) {const c=ledger.citation(item.ref,'');locations.push({documentId:c.cloudDocumentId,title:c.documentTitle,sectionPath:c.sectionPath,...(c.pageStart?{pageStart:c.pageStart,pageEnd:c.pageEnd}:{})});}
      if(r&&!group.evidence?.length)locations.push({documentId:r.id,title:r.title});
    }
    for(const card of [data?.currentDocument,...(data?.documents??[])].filter(Boolean))locations.push({documentId:documents.get(card.document),title:card.title||card.fileName||card.document,current:!!card.isCurrent});
    const unique=[...new Map(locations.map(l=>[JSON.stringify(l),l])).values()];
    return {version:1,operation:name,locations:unique.slice(0,12),totalLocations:unique.length,hasMore:!!data?.hasMore,
      query:input.query??input.queries?.join(' / '),...(data?.documents?{resultCount:data.documents.length}:{})};
  }
  return {execute,describeActivity,ledger,get metrics(){return {...ledger.metrics,scanChars,documentsRead:readers.size,discoveryCalls};},
    async assertCurrent(){if(!readers.size)return;const check=authorizeDocuments??(load===loadPublished?requireArtifactDocuments:undefined);if(check)await check(userId,[...readers.keys()]);else for(const r of readers.values())await r.assertAccess();}};
}
