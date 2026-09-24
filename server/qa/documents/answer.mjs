import { assertContextBudget } from './runtime.mjs';
import { DocumentToolError, requireCondition } from './errors.mjs';

// The schemas remain present for cache continuity. No tool executor is accepted
// here: once reading has finished, even a provider's new tool call cannot run.
export async function generateDocumentAnswer({ adapter, messages, tools, model, source, signal, context, onDelta, onReset, onUsage }) {
  const seen = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id)));
  let rejectedTools = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    await source?.assertCurrent();
    assertContextBudget({ model, messages, tools });
    const completion = await context.modelCall(attempt ? 'answer_repair' : 'answer_generate', () =>
      adapter.stream({ messages, tools, signal, onDelta, onUsage }));
    if (!completion?.calls?.length) return { rejectedTools };
    onReset();
    if (completion.message.content) {
      context.events.commentaryDelta?.(completion.message.content);
      await context.events.flushCommentary?.();
    }
    requireCondition(completion.calls.length <= 4, 'MODEL_PROTOCOL_ERROR', '回答阶段的意外工具调用超过纠正上限。', { retryable: false });
    messages.push(completion.message);
    for (const call of completion.calls) {
      requireCondition(!seen.has(call.id), 'MODEL_PROTOCOL_ERROR', '模型重复使用了旧工具调用 ID。', { retryable: false });
      seen.add(call.id); rejectedTools++;
      const error = new DocumentToolError('TOOLS_CLOSED', '查阅和引用核对已经结束。工具没有执行，请使用已允许的引用生成最终回答，不再调用工具。');
      const result = { callId: call.id, ok: false, error: { code: error.code, message: error.message, retryable: attempt === 0 } };
      await context.events.tool({ call, input: { executionClosed: true }, result, startedAt: Date.now(), evidenceIds: [], error });
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    requireCondition(attempt === 0, 'MODEL_PROTOCOL_ERROR', '模型在纠正后仍试图调用已关闭的工具。', { retryable: false });
  }
}
