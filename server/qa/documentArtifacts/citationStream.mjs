// Incremental public-text parser. Keeps only an unfinished delimiter/reference,
// leaves code/math untouched and publishes metadata BEFORE its first marker.
export function createCitationStream({ ledger, messageId, attemptId, onDelta, onCitations, maxAnswerChars = 160000 }) {
  let pending='',answer='',mode='text',delimiter='',lineStart=true,count=0,discardMarker=false;
  const chosen=new Map(), rejected=new Set(); let outputBuffer='';
  const flush=()=>{if(outputBuffer){onDelta(outputBuffer);outputBuffer='';}};
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
          const ref=match[1];let selected=chosen.get(ref);
          if(!selected){try{if(!ref.startsWith('R'))throw new Error('Use R handles');
            if(chosen.size>=32)throw new Error('Citation limit');
            selected={...ledger.citation(ref,`C${chosen.size+1}`),id:`${messageId}:${attemptId}:${ref}`,messageId,createdAt:Date.now()};
            chosen.set(ref,selected);flush();onCitations([...chosen.values()]);
          }catch{rejected.add(ref);}}
          if(selected)output(`[${selected.evidenceId}]`);
          pending=pending.slice(match[0].length);continue;
        }
        if(/^\[(?:[RC][0-9]*(?:\.[0-9]*)?)?$/.test(pending)){if(pending.length>32){rejected.add('oversized_reference');discardMarker=true;pending='';break;}if(!final)break;rejected.add(pending);pending='';continue;}
      }
      output(pending[0]);pending=pending.slice(1);
    }
    flush();
  }
  return {push:text=>feed(text),finish(){feed('',true);return {answer,citations:[...chosen.values()],rejected:[...rejected]};},get answer(){return answer;}};
}
