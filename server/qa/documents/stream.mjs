import { createOrReuseQaThread, listQaMessagesForThread, insertQaMessage, updateQaMessage, insertQaCitations, deleteQaMessage } from '../../supabase/qa.mjs';
import { writeJson } from '../../http/json.mjs';
import { createDeferredDocumentSource } from './source.mjs';
import { createQaToolAdapter, assertDocumentToolModel } from '../../chatModels/qaToolAdapter.mjs';
import { createDocumentRunContext } from './runContext.mjs';
import { runDocumentPlanning, createGeneralMessages, DOCUMENT_PROMPT_VERSION, DOCUMENT_RUNTIME_VERSION } from './runtime.mjs';
import { generateDocumentAnswer } from './answer.mjs';
import { DOCUMENT_TOOLS } from './tools.mjs';
import { verifyDocumentAnswer } from './citations.mjs';
import { requireCondition } from './errors.mjs';

export async function handleDocumentStream(request, response, user, body, dependencies = {}) {
  const db = dependencies.db ?? { createOrReuseQaThread, listQaMessagesForThread, insertQaMessage, updateQaMessage, insertQaCitations, deleteQaMessage };
  const makeAdapter = dependencies.createAdapter ?? createQaToolAdapter;
  const loadSource = dependencies.loadSource ?? createDeferredDocumentSource;
  const makeContext = dependencies.createContext ?? createDocumentRunContext;
  const disconnected = new AbortController();
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(dependencies.timeoutMs ?? 300000)]);
  let assistant, context, heartbeat, answer = '', usage, snapshot, thread;
  const general = body.scope === 'general', scope = general ? 'general' : 'current';
  const tools = general ? [] : DOCUMENT_TOOLS;
  const emit = (event, payload) => {
    if (!response.destroyed && !response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  response.once('close', () => { clearInterval(heartbeat); disconnected.abort(); });
  try {
    assertDocumentToolModel(body.model);
    const adapter = makeAdapter({ model: body.model, reasoningEffort: body.reasoningEffort });
    thread = await db.createOrReuseQaThread({ activeUserDocumentId: body.activeDocumentId, userId: user.id,
      question: body.question, threadId: body.threadId, scope });
    const previous = await db.listQaMessagesForThread({ threadId: thread.id, userId: user.id });
    let userMessage;
    if (body.regenerateMessageId) {
      const last = previous.at(-1);
      requireCondition(last?.id === body.regenerateMessageId && last.role === 'assistant', 'INVALID_REGENERATE_TARGET', '只能重新生成当前会话的最后一条回答。');
      userMessage = previous.findLast((m) => m.role === 'user');
      requireCondition(userMessage, 'INVALID_REGENERATE_TARGET', '未找到对应提问。');
      await db.deleteQaMessage({ messageId: last.id, userId: user.id });
    } else userMessage = await db.insertQaMessage({ content: body.question, role: 'user', status: 'success', threadId: thread.id, userId: user.id });
    assistant = await db.insertQaMessage({ content: '', role: 'assistant', status: 'streaming', model: body.model,
      promptVersion: DOCUMENT_PROMPT_VERSION, threadId: thread.id, userId: user.id });
    context = makeContext({ userId: user.id, userDocumentId: body.activeDocumentId, messageId: assistant.id, threadId: thread.id, model: body.model, emit });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders?.();
    heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) response.write(': keep-alive\n\n'); }, 10000); heartbeat.unref?.();
    emit('meta', { assistantMessageId: assistant.id, userMessageId: userMessage.id, threadId: thread.id,
      model: body.model, executionMode: 'agentic', runtime: DOCUMENT_RUNTIME_VERSION, promptVersion: DOCUMENT_PROMPT_VERSION, reasoningEffort: body.reasoningEffort, scope });
    const chatContext = { recentMessages: previous.filter((m) => m.id !== body.regenerateMessageId && m.status === 'success') };
    let source, result;
    if (general) {
      result = { prepared: { mode: 'direct', allowedCitationIds: [], citations: [] },
        messages: createGeneralMessages({ question: userMessage.content, answerLanguage: body.answerLanguage, chatContext }),
        metrics: { toolCalls: 0, returnedChars: 0, scanChars: 0, cacheHits: 0 }, stopReason: 'direct_answer' };
    } else {
      await context.events.step('plan', '检查当前文档的解析来源与可读性。', { phase: 'document_load' });
      source = await loadSource({ userId: user.id, userDocumentId: body.activeDocumentId }, { signal });
      result = await runDocumentPlanning({ source, adapter, model: body.model, question: userMessage.content, answerLanguage: body.answerLanguage,
        chatContext, signal, events: context.events, onModelCall: context.modelCall.bind(context) });
    }
    const { prepared, messages } = result;
    snapshot = { scope, activeCloudDocumentId: body.activeDocumentId, referenceDocumentIds: [],
      queryPlan: { intent: general ? 'direct_chat' : 'model_document_reading', rewrittenQueries: [], requiredEvidence: 'multi', answerFormat: 'paragraph' },
      retrieverVersion: DOCUMENT_RUNTIME_VERSION, documentVersion: source?.view.documentVersion,
      evidence: prepared.citations.map(toEvidenceSnapshot), diagnostics: { ...result.metrics, stopReason: result.stopReason } };
    emit('retrieval', { snapshot, diagnostics: snapshot.diagnostics, warnings: general || result.stopReason === 'model_finish' ? [] : ['查阅因预算结束，引用为实际已读范围。'] });
    await context.events.step('answer_outline', prepared.mode === 'direct' ? '开始回答。' : '原文引用已完成位置映射，开始生成回答。',
      { phase: 'answer_generate', mode: prepared.mode, stopReason: result.stopReason }, undefined, prepared.allowedCitationIds);
    if (!general) messages.push({ role: 'user', content: JSON.stringify({ instruction: '查阅结束。现在生成最终回答，不再调用工具。只使用以下通过 harness 映射的引用编号，关键论文论断分别附引用。证据不足须说明，不补写论文事实。',
      answerLanguage: body.answerLanguage ?? 'follow_user', mode: prepared.mode, allowedCitationIds: prepared.allowedCitationIds, answerOutline: prepared.answerOutline }) });
    const generated = await generateDocumentAnswer({ adapter, messages, tools, model: body.model, source, signal, context,
      onDelta: (text) => { answer += text; emit('delta', { text }); },
      onReset: () => { answer = ''; emit('answer_reset', {}); },
      onUsage: (next) => { usage = next; context.events.modelUsage(next); emit('usage', next); } });
    result.metrics.answerToolRejections = generated.rejectedTools;
    snapshot.diagnostics.answerToolRejections = generated.rejectedTools;
    emit('finish', { finishReason: 'stop' });
    context.setPhase('persist_answer');
    await source?.assertCurrent();
    const verified = verifyDocumentAnswer(answer, prepared);
    const citations = await db.insertQaCitations({ citations: verified.citations, messageId: assistant.id, userId: user.id });
    const status = verified.valid ? 'success' : 'error';
    const errorMessage = verified.valid ? undefined : verified.warnings.join(' ');
    const updated = await db.updateQaMessage({ messageId: assistant.id, userId: user.id, content: answer, retrievalSnapshot: snapshot,
      status, errorMessage, usage });
    await context.terminal({ status, stopReason: verified.valid ? result.stopReason : 'citation_verification_failed', usage,
      payload: { ...result.metrics, citationCount: citations.length, verifierWarnings: verified.warnings } });
    emit('citation', { citations }); emit('verifier', { warnings: verified.warnings, rejected: verified.rejected });
    emit('done', { threadId: thread.id, assistantMessage: { ...updated, agentSteps: context.steps, citations }, citations });
    response.end();
  } catch (error) {
    const aborted = disconnected.signal.aborted;
    const status = aborted ? 'aborted' : 'error';
    const message = aborted ? '问答已取消。' : signal.aborted ? '本次问答超时。' : error.message || '文档问答失败。';
    if (assistant) {
      await db.updateQaMessage({ messageId: assistant.id, userId: user.id, content: answer, retrievalSnapshot: snapshot,
        status, errorMessage: message, usage }).catch(() => {});
    }
    try { await context?.terminal({ status, error, usage, stopReason: aborted ? 'cancelled' : signal.aborted ? 'timeout' : error.code ?? 'runtime_error' }); }
    catch { console.error('[qa-document-tools] terminal persistence failed'); }
    if (response.headersSent) { emit('error', { code: error.code ?? (aborted ? 'qa_aborted' : 'qa_document_failed'), message }); response.end(); }
    else writeJson(response, error.statusCode ?? 500, { error: { code: error.code ?? 'qa_document_failed', message } });
  } finally { clearInterval(heartbeat); }
}
function toEvidenceSnapshot(c) {
  const { start: _start, end: _end, ...evidence } = c;
  return { ...evidence, textPreview: c.quotedText, sourceText: c.text };
}
