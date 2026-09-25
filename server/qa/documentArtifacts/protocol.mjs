import { WORKSPACE_SYSTEM_PROMPT, createWorkspaceMessages } from '../workspace/runtime.mjs';
import { ARTIFACT_TOOLS } from './tools.mjs';
import { createCitationStream } from './citationStream.mjs';
export const ARTIFACT_RUNTIME_VERSION='workspace-artifacts-v1';
export const ARTIFACT_PROMPT_VERSION='qa-workspace-artifacts-v1';
export const ARTIFACT_SYSTEM_PROMPT=WORKSPACE_SYSTEM_PROMPT.replace(/阅读到相关资料后，[\s\S]*?标记引用后仍可继续阅读。/,
  '需要支持文档事实时，在相应论断旁直接使用本次阅读工具返回的 [R1] 等 ref。段落的 sentences 提供 [R1.1] 等关键句句柄；选择能支撑论断的句子，引用整段可用父 ref。软件自动处理原文位置和显示编号，你不需要定位页行、抄写引用或调用标记工具。目录和未读段落不能引用；历史中的 C/R 编号不属于本次。普通交流自然回答，无需引用。')
  .replace('latexLines 可帮助保真呈现公式，但引用摘录仍来自 text。','阅读正文中的 LaTeX 可用于保真呈现公式。');
export function createArtifactProtocol({workspace,messageId,onCitations=()=>{}}){
  let attempt=0,stream;
  return {tools:ARTIFACT_TOOLS,
    messages(options){const messages=createWorkspaceMessages(options);messages[0].content=messages[0].content.replace(WORKSPACE_SYSTEM_PROMPT,ARTIFACT_SYSTEM_PROMPT);return messages;},
    begin(onDelta){stream=createCitationStream({ledger:workspace.ledger,messageId,attemptId:++attempt,onDelta,onCitations});return text=>stream.push(text);},
    reset(){onCitations([]);},
    verify(){const parsed=stream.finish(),warnings=[];if(parsed.rejected.length)warnings.push('仅可使用本轮阅读结果提供的 R 编号。');
      if(workspace.metrics.returnedChars>0&&!parsed.citations.length)warnings.push('请在文档事实旁引用已经读到的 R 来源。');
      return {answer:parsed.answer,verified:{valid:!warnings.length,warnings,citations:parsed.citations,rejected:parsed.rejected}};},
    repair:'请直接引用本次阅读结果中的 [R1] 或关键句 [R1.1]，不要编造编号；无需调用引用工具。',
  };
}
