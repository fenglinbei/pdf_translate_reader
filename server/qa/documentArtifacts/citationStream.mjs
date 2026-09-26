// Incremental public-text parser. Keeps only an unfinished delimiter/reference,
// leaves code/math untouched and publishes metadata BEFORE its first marker.
import { QA_ANSWER_BUDGET } from '../../../shared/qaAnswerBudget.mjs';
export function createCitationStream({ ledger, messageId, attemptId, onDelta, onCitations,
  maxAnswerChars = QA_ANSWER_BUDGET.maxAnswerChars, replacements = new Map() }) {
  let pending='',answer='',mode='text',delimiter='',lineStart=true,count=0,discardMarker=false;
  const chosen=new Map(), issues=new Map(); let outputBuffer='',metadataDirty=false;
  const reject=(ref,code)=>issues.set(ref,{ref,code});
  // One metadata snapshot per provider frame, still before any matching marker.
  // A frame containing many citations must not enqueue quadratic SSE payloads.
  const flush=()=>{if(metadataDirty){onCitations([...chosen.values()]);metadataDirty=false;}if(outputBuffer){onDelta(outputBuffer);outputBuffer='';}};
  function output(text){if(!text)return;answer+=text;outputBuffer+=text;for(const c of text)lineStart=c==='\n'?true:lineStart&&c===' ';}
  function feed(value,final=false){
    count+=value.length;if(count>maxAnswerChars)throw Object.assign(new Error('回答超过本次输出上限。'),{code:'ANSWER_LIMIT'});
    pending+=value;
    while(pending){
      if(discardMarker){const end=pending.indexOf(']');if(end<0){pending='';break;}pending=pending.slice(end+1);discardMarker=false;continue;}
      if(pending[0]==='\\'&&mode!=='code'&&mode!=='fence'){
        if(pending.length===1&&!final)break;
        const pair=pending.slice(0,2);
        output(pair);pending=pending.slice(pair.length);continue;
      }
      if(pending[0]==='`'||pending[0]==='~'){
        const char=pending[0],run=pending.match(char==='`'?/^`+/:/^~+/)[0];
        if(run.length===pending.length&&!final)break;
        if(mode==='text'&&(char==='`'||lineStart&&run.length>=3)){mode=lineStart&&run.length>=3?'fence':'code';delimiter=run;}
        else if((mode==='code'&&run===delimiter)||(mode==='fence'&&lineStart&&char===delimiter[0]&&run.length>=delimiter.length)){mode='text';delimiter='';}
        output(run);pending=pending.slice(run.length);continue;
      }
      if((mode==='text'||mode==='math')&&pending[0]==='$'){
        if(pending.length===1&&!final)break;
        const token=pending.startsWith('$$')?'$$':'$';
        if(mode==='text'){mode='math';delimiter=token;}else if(token===delimiter){mode='text';delimiter='';}
        output(token);pending=pending.slice(token.length);continue;
      }
      if(mode==='text'&&pending[0]==='['){
        const match=/^\[([RC][0-9]+(?:\.[0-9]+)?)\]/.exec(pending);
        if(match){
          const originalRef=match[1],ref=replacements.get(originalRef)??originalRef;let selected=chosen.get(ref);
          if(!selected){
            if(!ref.startsWith('R'))reject(originalRef,'DISPLAY_REFERENCE_NOT_ALLOWED');
            else {
              let citation;
              try{citation=ledger.citation(ref,`C${chosen.size+1}`);}
              catch(error){if(error.code&&error.code!=='UNKNOWN_READ_REFERENCE')throw error;reject(originalRef,'UNKNOWN_READ_REFERENCE');}
              if(citation){
                if(chosen.size>=QA_ANSWER_BUDGET.maxCitations)reject(originalRef,'CITATION_LIMIT');
                else{selected={...citation,id:`${messageId}:${attemptId}:${ref}`,messageId,createdAt:Date.now()};
                  chosen.set(ref,selected);metadataDirty=true;}
              }
            }
          }
          if(selected)output(`[${selected.evidenceId}]`);
          pending=pending.slice(match[0].length);continue;
        }
        if(/^\[(?:[RC][0-9]*(?:\.[0-9]*)?)?$/.test(pending)){if(pending.length>32){reject('oversized_reference','MALFORMED_REFERENCE');discardMarker=true;pending='';break;}if(!final)break;reject(pending,'MALFORMED_REFERENCE');pending='';continue;}
      }
      output(pending[0]);pending=pending.slice(1);
    }
    flush();
  }
  return {push:text=>feed(text),finish(){feed('',true);return {answer,citations:[...chosen.values()],rejected:[...issues.keys()],issues:[...issues.values()]};},get answer(){return answer;}};
}
