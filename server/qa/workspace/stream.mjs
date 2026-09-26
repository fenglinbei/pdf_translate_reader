import { requireUserDocument, createOrReuseQaThread, listQaMessagesForThread, insertQaMessage, updateQaMessage, insertQaCitations, commitArtifactAnswer, deleteQaMessage } from '../../supabase/qa.mjs';
import { writeJson } from '../../http/json.mjs';
import { createQaToolAdapter, assertDocumentToolModel } from '../../chatModels/qaToolAdapter.mjs';
import { createDocumentRunContext } from '../documents/runContext.mjs';
import { runWorkspaceAgent, WORKSPACE_PROMPT_VERSION as DOCUMENT_PROMPT_VERSION, WORKSPACE_RUNTIME_VERSION as DOCUMENT_RUNTIME_VERSION } from './runtime.mjs';
import { createWorkspaceTools } from './tools.mjs';
import { createArtifactWorkspace } from '../documentArtifacts/tools.mjs';
import { createArtifactProtocol, ARTIFACT_RUNTIME_VERSION, ARTIFACT_PROMPT_VERSION } from '../documentArtifacts/protocol.mjs';
import { createSseWriter } from '../sseWriter.mjs';
import { requireCondition } from '../documents/errors.mjs';

export async function handleWorkspaceStream(request, response, user, body, dependencies = {}) {
  const db = dependencies.db ?? { createOrReuseQaThread, listQaMessagesForThread, insertQaMessage, updateQaMessage, insertQaCitations, commitArtifactAnswer, deleteQaMessage };
  const makeAdapter = dependencies.createAdapter ?? createQaToolAdapter;
  const makeContext = dependencies.createContext ?? createDocumentRunContext;
  const disconnected = new AbortController();
  const signal = AbortSignal.any([disconnected.signal, AbortSignal.timeout(dependencies.timeoutMs ?? 300000)]);
  let assistant, context, heartbeat, answer = '', usage, snapshot, thread, committed = false;
  const artifacts = dependencies.artifacts ?? process.env.QA_AGENT_RUNTIME === ARTIFACT_RUNTIME_VERSION;
  const runtimeVersion = artifacts ? ARTIFACT_RUNTIME_VERSION : DOCUMENT_RUNTIME_VERSION;
  const promptVersion = artifacts ? ARTIFACT_PROMPT_VERSION : DOCUMENT_PROMPT_VERSION;
  const scope = 'workspace';
  const writer = createSseWriter(response, { onFailure: error => disconnected.abort(error) });
  const emit = writer.emit;
  response.once('close', () => { clearInterval(heartbeat); disconnected.abort(); });
  try {
    assertDocumentToolModel(body.model);
    if (body.activeDocumentId) await (dependencies.requireDocument ?? requireUserDocument)({ userId: user.id, userDocumentId: body.activeDocumentId });
    const adapter = makeAdapter({ model: body.model, reasoningEffort: body.reasoningEffort });
    thread = await db.createOrReuseQaThread({ activeUserDocumentId: undefined, userId: user.id,
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
      promptVersion, threadId: thread.id, userId: user.id });
    context = makeContext({ userId: user.id, userDocumentId: body.activeDocumentId, messageId: assistant.id, threadId: thread.id, model: body.model, emit, runtimeVersion, promptVersion, duplicateObservations: false, recordToolTrace: true });
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders?.();
    heartbeat = setInterval(() => { if (!response.destroyed && !response.writableEnded) writer.heartbeat(); }, 10000); heartbeat.unref?.();
    emit('meta', { assistantMessageId: assistant.id, userMessageId: userMessage.id, threadId: thread.id,
      model: body.model, executionMode: 'agentic', runtime: runtimeVersion, promptVersion, reasoningEffort: body.reasoningEffort, scope });
    const recentMessages = previous.filter(m => m.id !== body.regenerateMessageId && (!body.regenerateMessageId || m.id !== userMessage.id));
    const workspace = dependencies.workspace ?? (artifacts ? createArtifactWorkspace : createWorkspaceTools)({ userId: user.id, activeDocumentId: body.activeDocumentId, signal });
    const protocol = artifacts ? createArtifactProtocol({ workspace, messageId: assistant.id, onCitations: citations => emit('citation', { citations }) }) : undefined;
    const result = await runWorkspaceAgent({ protocol, adapter, model: body.model, question: userMessage.content, userId: user.id,
      activeDocumentId: body.activeDocumentId, answerLanguage: body.answerLanguage, recentMessages, signal, context, workspace,
      allowCitationUpdates: body.supportsAnswerUpdate === true,
      onDelta: text => { answer += text; emit('delta', { text }); },
      onReset: () => { answer = ''; emit('answer_reset', {}); },
      onAnswerUpdate: (text, citations) => { answer = text; emit('answer_update', { text, citations }); },
      onUsage: next => { usage = next; emit('usage', next); } });
    answer = result.answer;
    const verified = result.verified;
    snapshot = { scope, activeCloudDocumentId: body.activeDocumentId,
      referenceDocumentIds: [...new Set(verified.citations.map(c => c.cloudDocumentId))],
      queryPlan: { intent: result.metrics.returnedChars ? 'model_document_reading' : 'direct_chat', rewrittenQueries: [], requiredEvidence: 'multi', answerFormat: 'paragraph' },
      retrieverVersion: runtimeVersion, evidence: verified.citations.map(toEvidenceSnapshot),
      diagnostics: { ...result.metrics, stopReason: result.stopReason } };
    emit('retrieval', { snapshot, diagnostics: snapshot.diagnostics, warnings: [] });
    emit('finish', { finishReason: 'stop' });
    context.setPhase('persist_answer');
    await workspace.assertCurrent();
    let citations, updated;
    const status = verified.valid ? 'success' : 'error';
    const errorMessage = verified.valid ? undefined : verified.warnings.join(' ');
    if (artifacts) {
      const saved = await db.commitArtifactAnswer({ citations: verified.citations, messageId: assistant.id, userId: user.id,
        content: answer, retrievalSnapshot: snapshot, usage });
      citations = saved.citations; updated = saved.message;
    } else {
      citations = await db.insertQaCitations({ citations: verified.citations, messageId: assistant.id, userId: user.id });
      updated = await db.updateQaMessage({ messageId: assistant.id, userId: user.id, content: answer, retrievalSnapshot: snapshot, status, errorMessage, usage });
    }
    committed = true;
    try { await context.terminal({ status, stopReason: verified.valid ? result.stopReason : 'citation_verification_failed', usage,
      payload: { ...result.metrics, citationCount: citations.length, verifierWarnings: verified.warnings } }); }
    catch { console.error('[qa-workspace] terminal log failed after answer commit'); }
    emit('citation', { citations }); emit('verifier', { warnings: verified.warnings, rejected: verified.rejected });
    emit('done', { threadId: thread.id, assistantMessage: { ...updated, agentSteps: context.steps, citations }, citations });
    await writer.end();
  } catch (error) {
    const aborted = disconnected.signal.aborted;
    const status = aborted ? 'aborted' : 'error';
    const message = aborted ? '问答已取消。' : signal.aborted ? '本次问答超时。' : error.message || '文档问答失败。';
    if (assistant && !committed) {
      await db.updateQaMessage({ messageId: assistant.id, userId: user.id, content: answer, retrievalSnapshot: snapshot,
        status, errorMessage: message, usage }).catch(() => {});
    }
    try { await context?.terminal({ status, error, usage, stopReason: aborted ? 'cancelled' : signal.aborted ? 'timeout' : error.code ?? 'runtime_error' }); }
    catch { console.error('[qa-workspace] terminal persistence failed'); }
    if (response.headersSent) { emit('error', { code: error.code ?? (aborted ? 'qa_aborted' : 'qa_document_failed'), message }); await writer.end(); }
    else writeJson(response, error.statusCode ?? 500, { error: { code: error.code ?? 'qa_document_failed', message } });
  } finally { clearInterval(heartbeat); }
}
function toEvidenceSnapshot(c) {
  const { start: _start, end: _end, ...evidence } = c;
  return { ...evidence, textPreview: c.quotedText, sourceText: c.text };
}
