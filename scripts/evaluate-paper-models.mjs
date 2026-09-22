// Uses downloaded public papers only. Raw answers stay in the requested local
// output file; commit metrics/review notes, not redistributed paper text.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import dotenv from "dotenv";
import { getModelIds } from "../shared/modelRegistry.mjs";
import { streamQaChatCompletion } from "../server/chatModels/client.mjs";
import { buildQaAnswerMessages } from "../server/qa/prompt.mjs";
import { computeAnswerContextBudget } from "../server/qa/contextBudget.mjs";

const args=process.argv.slice(2);
if(!args.includes("--run")) {
  console.log("Prepare with scripts/prepare-paper-evaluation.py, then use --run --papers=/tmp/pdf-model-public-papers/papers.json --output=/tmp/paper-model-results.json. Optional --include-optional, --models=id,id.");
  process.exit(0);
}
const value=(name,fallback)=>args.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const papers=JSON.parse(await readFile(value("papers","/tmp/pdf-model-public-papers/papers.json"),"utf8"));
dotenv.config({path:".env"});dotenv.config({path:".env.local",override:true});
const allModels=[...getModelIds({tier:"core"}),...getModelIds({tier:"optional"})];
const models=value("models","") ? value("models").split(",") : getModelIds({tier:"core"});
if(args.includes("--include-optional") && !args.some(arg=>arg.startsWith("--models="))) models.push(...getModelIds({tier:"optional"}));
if(models.some(model=>!allModels.includes(model))) throw Error("Use exact core/optional model IDs.");
const paperById=Object.fromEntries(papers.map(p=>[p.id,p]));

const checks=(...items)=>Object.fromEntries(items);
const cites=(text,id="C1")=>text.includes(`[${id}]`);
const uncertain=text=>/未|没有|无法|不能|不足|不代表|不等于|不一定|不可|不应|难以/.test(text);
const cases=[
  {id:"en_summary",paper:"attention",mode:"long_context",question:"用中文概括这篇论文的核心架构变化、两项主要机器翻译结果和结论适用范围，控制在 200 字内，并标明相关章节。",
    rubric:"Transformer/self-attention; 28.4 and 41.8 BLEU; restrict conclusion to reported tasks.",
    check:t=>checks(["architecture",/Transformer/i.test(t)&&/注意力|attention/i.test(t)],["reported_results",/28\.4/.test(t)&&/41\.8/.test(t)],["scope",/翻译|WMT|机器翻译/.test(t)])},
  {id:"en_formula",paper:"attention",pages:[4],question:"解释式(1)中为什么除以 sqrt(d_k)，而不是直接除以 d_k。若 d_k=64，缩放分母是多少？请用公式和原文证据回答，不超过 160 字。",
    mmd:"\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}(QK^T/\\sqrt{d_k})V. Under independent unit-variance components, Var(q dot k)=d_k.",
    rubric:"Denominator 8; variance grows with d_k; mitigate softmax saturation/small gradients; cite C1.",
    check:t=>checks(["denominator",/8/.test(t)],["variance",/方差|variance/i.test(t)],["gradient",/梯度|饱和|gradient|saturat/i.test(t)],["citation",cites(t)])},
  {id:"en_table",paper:"attention",pages:[8],question:"仅看表2的 WMT14 英德 BLEU，Transformer big 比 base 高多少分？同时给出二者原值和证据引用，控制在 100 字内。",
    rubric:"big 28.4; base 27.3; absolute difference 1.1 BLEU, not percentage points.",
    check:t=>checks(["values",/28\.4/.test(t)&&/27\.3/.test(t)],["difference",/1\.1/.test(t)],["citation",cites(t)])},
  {id:"en_followup",paper:"attention",pages:[8],previous:"en_table",question:"那相对提升百分比是多少？该表给出了这个差异的 95% 置信区间吗？区分自行计算与原文报告，控制在 140 字内。",
    rubric:"Computed relative improvement about 4.03%; no 95% CI in supplied table; cite current evidence.",
    check:t=>checks(["relative_calculation",/4\.0(?:[23]\d*)?\s*[%％]|4\s*%/.test(t)],["missing_interval",uncertain(t)&&/置信|区间/.test(t)],["citation",cites(t)])},
  {id:"zh_summary",paper:"multilingual",mode:"long_context",question:"用不超过 250 字概括这篇综述的研究对象、前沿方向和主要挑战，区分综述归纳与作者提出的新模型，并标明相关章节。",
    rubric:"Survey, not a new model; multilingual training/alignment/extension; fairness/safety, curse and training cost.",
    check:t=>checks(["survey",/综述|梳理|归纳/.test(t)],["directions",/对齐/.test(t)&&/扩展|拓展/.test(t)],["challenges",/公平|安全/.test(t)&&/诅咒/.test(t)&&/代价|成本/.test(t)])},
  {id:"zh_evidence",paper:"multilingual",pages:[4],question:"ROOTS 的 59 种语言是否全是自然语言？请区分具体类别，并解释为什么不能把 59 直接用作自然语言覆盖数。必须引用证据，不超过 120 字。",
    rubric:"46 natural plus 13 programming; 59 includes both categories; cite C1 (printed p66).",
    check:t=>checks(["natural",/46/.test(t)&&/自然/.test(t)],["programming",/13/.test(t)&&/编程|程序/.test(t)],["citation",cites(t)])},
  {id:"zh_data",paper:"multilingual",pages:[4],question:"按 Aya、Bactrain-X 的顺序比较二者指令数据的构造方式及质量限制；论文是否以统一实验直接证明一个全面优于另一个？必须引用证据，不超过 200 字。",
    rubric:"Aya human contribution/filtering; Bactrain-X translation plus gpt-3.5-turbo answers and low-resource noise; no unified superiority experiment.",
    check:t=>checks(["human",/人工/.test(t)],["synthetic",/翻译|机翻|译成/.test(t)&&/gpt|GPT|模型/.test(t)],["noise",/噪|低资源/.test(t)],["unsupported_comparison",uncertain(t)],["citation",cites(t)])},
  {id:"zh_followup",paper:"multilingual",pages:[4],previous:"zh_data",question:"刚才后者的 6 万 7 千条是每种语言还是所有语言合计？据文中语言数估算总量，并说明这个估算能否单独证明它比前者质量更高。引用证据，不超过 160 字。",
    rubric:"Bactrain-X has 67k per language across 51, estimated 3,417,000; quantity cannot prove quality over Aya.",
    check:t=>checks(["per_language",/每[种个]?语言|每种|各语言/.test(t)],["total",/341[,.，]?7|3[,.]417|3,417,000|3417000|342\s*万/.test(t)],["quality_limit",uncertain(t)&&/质量|优于/.test(t)],["citation",cites(t)])},
];

const report={schemaVersion:1,startedAt:new Date().toISOString(),reasoningEffort:"standard",concurrency:2,sources:papers.map(({pages,...source})=>({...source,pageCount:pages.length})),cases:cases.map(({check,mmd,...sample})=>sample),results:[]};
function messagesFor(model,sample,answers){
  const paper=paperById[sample.paper];
  const previous=cases.find(c=>c.id===sample.previous);
  const chatContext=previous?{recentMessages:[{role:"user",content:previous.question},{role:"assistant",content:answers.get(previous.id)??"前一轮回答不可用。"}]}:undefined;
  const evidence=(sample.pages??[]).map((number,index)=>({evidenceId:`C${index+1}`,documentTitle:paper.title,pageStart:number+paper.pageOffset,pageEnd:number+paper.pageOffset,sectionPath:[`PDF page ${number}`],text:paper.pages[number-1],mmd:sample.mmd}));
  return buildQaAnswerMessages({question:sample.question,answerLanguage:"zh",mode:sample.mode??"answer",budget:computeAnswerContextBudget({model,mode:sample.mode??"answer"}),paperTitle:paper.title,fullPaperText:paper.pages.slice(0,paper.bodyPages).map((text,index)=>`[PDF page ${index+1}]\n${text}`).join("\n\n"),chatContext,evidence});
}

async function evaluate(model){
  const answers=new Map();
  for(const sample of cases){
    const started=Date.now();let content="",usage,finishReason,firstContentMs;
    try{
      const messages=messagesFor(model,sample,answers);
      await streamQaChatCompletion({model,messages,reasoningEffort:"standard",signal:AbortSignal.timeout(120000),onDelta:text=>{firstContentMs??=Date.now()-started;content+=text;},onUsage:value=>usage=value,onFinish:value=>finishReason=value});
      answers.set(sample.id,content);
      const criteria=sample.check(content);
      report.results.push({model,caseId:sample.id,status:Object.values(criteria).every(Boolean)?"pass":"review",criteria,durationMs:Date.now()-started,firstContentMs,finishReason,usage,content,answerSha256:createHash("sha256").update(content).digest("hex"),inputChars:messages.reduce((n,m)=>n+m.content.length,0)});
    }catch(error){report.results.push({model,caseId:sample.id,status:"error",durationMs:Date.now()-started,errorCode:error.code??error.name,statusCode:error.statusCode});}
    const result=report.results.at(-1);
    console.log(JSON.stringify({model,caseId:sample.id,status:result.status,durationMs:result.durationMs}));
  }
}
let cursor=0;
await Promise.all(Array.from({length:Math.min(2,models.length)},async()=>{while(cursor<models.length) await evaluate(models[cursor++]);}));
report.finishedAt=new Date().toISOString();
await writeFile(value("output","/tmp/paper-model-results.json"),JSON.stringify(report,null,2)+"\n");
process.exitCode=report.results.some(result=>result.status==="error")?1:0;
