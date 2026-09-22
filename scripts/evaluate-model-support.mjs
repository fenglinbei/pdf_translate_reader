// Explicit, bounded paid API evaluation using synthetic text only.
// node scripts/evaluate-model-support.mjs --run --include-optional --output=/tmp/model-evaluation.json
import { writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { getModelIds, MODEL_CATALOG_VERSION } from "../shared/modelRegistry.mjs";
import { createTranslationChatStream } from "../server/translationModels/client.mjs";
import { streamQaChatCompletion } from "../server/chatModels/client.mjs";
import { classifyQuestionType } from "../server/qa/queryRouter.mjs";
import { buildQaAnswerMessages } from "../server/qa/prompt.mjs";

const args = process.argv.slice(2);
if (!args.includes("--run")) {
  console.log("Use --run to make paid API calls with five synthetic cases per model. Optional: --include-optional, --only-router, --models=id,id, --output=/tmp/results.json.");
  process.exit(0);
}
dotenv.config({path: ".env"});
dotenv.config({path: ".env.local", override: true});
const allowed = [...getModelIds({tier:"core"}), ...getModelIds({tier:"optional"})];
const modelsArg = args.find(arg=>arg.startsWith("--models="))?.slice(9);
const models = modelsArg ? [...new Set(modelsArg.split(","))] : getModelIds({tier:"core"});
if (!modelsArg && args.includes("--include-optional")) models.push(...getModelIds({tier:"optional"}));
if (models.some(model=>!allowed.includes(model))) throw new Error("Use exact core/optional catalog IDs.");

const evidence = [
  {evidenceId:"C1",documentTitle:"Synthetic retrieval benchmark",pageStart:1,pageEnd:1,sectionPath:["Results"],text:"This is a synthetic test fixture, not a published study. On the same 400 questions, system A answered 320 correctly and system B answered 300 correctly. No confidence intervals, p-values, or per-question results are reported."},
  {evidenceId:"C2",documentTitle:"Synthetic retrieval benchmark",pageStart:2,pageEnd:2,sectionPath:["Metric"],text:"MSE = (1/n) * sum((prediction_i - observation_i)^2). In the example, predictions are [2, 4] and observations are [1, 2]."},
];
const qaCases = [
  {id:"qa_evidence_arithmetic",question:"A、B 的准确率分别是多少？A 比 B 高几个百分点？不超过三句话，引用证据。",check:text=>/80\s*%/.test(text)&&/75\s*%/.test(text)&&/5\s*(个)?百分点/.test(text)&&/\[C1\]/.test(text)},
  {id:"qa_missing_evidence",question:"该结果的 p 值是多少？是否达到统计显著？仅据已给证据回答，不超过两句话。",check:text=>/未|缺|不足|无法|不能|没有|不确定/.test(text)&&!/p\s*[=<]\s*0\.0[15]/i.test(text)},
  {id:"qa_formula_followup",question:"那第二个例子的 MSE 是多少？给出代入公式和结果，引用证据，不超过三句话。",chatContext:{recentMessages:[{role:"assistant",content:"前一个问题已经比较了两个系统的准确率。"}]},check:text=>/2\.5/.test(text)&&/\[C2\]/.test(text)},
];
const report={schemaVersion:1,catalogVersion:MODEL_CATALOG_VERSION,startedAt:new Date().toISOString(),scope:"Synthetic API and basic answer checks only; not representative paper-quality acceptance.",reasoningEffort:"QA standard; router quick; translation disabled where supported, otherwise low",results:[]};

async function measure(model, id, execute, check) {
  const started=Date.now();
  try {
    const result=await execute(AbortSignal.timeout(90_000));
    return {model,id,status:check(result.content)?"pass":"review",durationMs:Date.now()-started,...result};
  } catch(error) {
    // Never serialize provider response bodies, credentials or raw reasoning.
    return {model,id,status:"error",durationMs:Date.now()-started,errorCode:error.code??error.name,statusCode:error.statusCode};
  }
}

async function evaluate(model) {
  const results=[];
  if (!args.includes("--only-router")) results.push(await measure(model,"translation",async signal=>{
    const stream=await createTranslationChatStream({model,signal,messages:[{role:"system",content:"Translate into Chinese. Return only the translation. Keep numbers unchanged."},{role:"user",content:"The baseline answered 300 out of 400 questions correctly; this does not establish statistical significance."}],resolvedReasoning:{enabled:false,effort:"low"}});
    let buffer="",content="",finishReason,usage;
    const decoder=new TextDecoder();
    const consume=line=>{
      if(!line.startsWith("data:")) return;
      const data=line.slice(5).trim();
      if(!data || data==="[DONE]") return;
      const chunk=JSON.parse(data);
      if(chunk.error) throw Error("Provider stream error");
      content+=chunk.choices?.[0]?.delta?.content??"";
      finishReason=chunk.choices?.[0]?.finish_reason??finishReason;
      if(chunk.usage) usage=chunk.usage;
    };
    for await (const value of stream) {
      buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split(/\r?\n/);buffer=lines.pop()??"";
      lines.forEach(consume);
    }
    if(buffer.trim()) consume(buffer);
    if(finishReason!=="stop") throw Error("Incomplete translation");
    return {content,finishReason,usage};
  },text=>/300/.test(text)&&/400/.test(text)&&/[\u4e00-\u9fff]/.test(text)));
  // A missing model/key need not generate four more failed billable calls.
  if(results[0]?.status!=="error") {
    results.push(await measure(model,"qa_router_json",async signal=>({content:JSON.stringify(await classifyQuestionType({model,signal,question:"总结这篇论文的主要方法和结论。"}))}),text=>{
      try{const result=JSON.parse(text);return result.type==="global"&&!result.fallback;}catch{return false;}
    }));
    for(const sample of args.includes("--only-router") ? [] : qaCases) {
      results.push(await measure(model,sample.id,async signal=>{
        let content="",usage,finishReason,firstContentMs;
        const started=Date.now();
        await streamQaChatCompletion({model,signal,reasoningEffort:"standard",messages:buildQaAnswerMessages({...sample,answerLanguage:"zh",evidence}),onDelta:text=>{firstContentMs??=Date.now()-started;content+=text;},onUsage:value=>usage=value,onFinish:value=>finishReason=value});
        return {content,usage,finishReason,firstContentMs};
      },sample.check));
    }
  }
  report.results.push(...results);
  console.log(JSON.stringify({model,cases:results.map(({id,status,durationMs,errorCode})=>({id,status,durationMs,errorCode}))}));
}

// At most two providers/models in flight; no retries, no user documents.
let cursor=0;
await Promise.all(Array.from({length:Math.min(2,models.length)},async()=>{while(cursor<models.length) await evaluate(models[cursor++]);}));
report.finishedAt=new Date().toISOString();
const output=args.find(arg=>arg.startsWith("--output="))?.slice(9);
if(output) await writeFile(output,JSON.stringify(report,null,2)+"\n");
else console.log(JSON.stringify(report,null,2));
process.exitCode=report.results.some(result=>result.status==="error")?1:0;
