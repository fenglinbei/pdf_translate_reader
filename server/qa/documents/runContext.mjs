import { insertQaAgentStep, insertQaApiLog, insertQaToolCall } from '../../supabase/qa.mjs';
import { DOCUMENT_PROMPT_VERSION, DOCUMENT_RUNTIME_VERSION } from './runtime.mjs';

export function createDocumentRunContext({ userId, userDocumentId, messageId, threadId, model, emit,
  persistStep = insertQaAgentStep, persistTool = insertQaToolCall, persistLog = insertQaApiLog,
  runtimeVersion = DOCUMENT_RUNTIME_VERSION, promptVersion = DOCUMENT_PROMPT_VERSION, terminalLog = true }) {
  const startedAt = Date.now(), steps = [], modelCalls = [];
  let nextIndex = 0, phase = 'document_load', activeUsage, terminalWritten = false;
  const logScope = { userId, userDocumentId, messageId, threadId, model, promptVersion, retrieverVersion: runtimeVersion };
  async function insertStep(input) {
    const row = await persistStep({ ...input, stepIndex: nextIndex++ });
    steps.push(row); return row;
  }
  async function step(kind, summary, payload = {}, toolName, evidenceIds = [], status = 'success') {
    phase = payload.phase ?? phase;
    const row = await insertStep({ userId, messageId, kind, summary, toolName, evidenceIds, payload: { phase, ...payload }, status });
    emit('agent_step', { step: row }); return row;
  }
  const events = {
    step,
    modelUsage: (usage) => { activeUsage = usage; },
    async tool({ call, input, result, startedAt: toolStarted, evidenceIds, error }) {
      phase = 'tool_execution';
      const known = ['get_document_outline', 'search_document_text', 'read_document', 'finish_reading'].includes(call.name);
      const toolName = known ? call.name : 'unknown_tool';
      const summary = result.ok ? `${call.name} 完成${evidenceIds.length ? `，返回 ${evidenceIds.length} 项来源` : ''}。` : `工具未执行成功：${result.error.code}`;
      const row = await step('tool_call', summary, { callId: call.id, requestedTool: call.name.slice(0, 100),
        cacheHit: Boolean(result.data?.cacheHit), errorCode: result.error?.code }, toolName, evidenceIds, error ? 'error' : 'success');
      const toolCall = await persistTool({ userId, stepId: row.id, toolName, input, outputSummary: summary,
        resultEvidenceIds: evidenceIds, startedAt: toolStarted, finishedAt: Date.now(), status: error ? 'error' : 'success',
        errorMessage: error ? result.error.message : undefined });
      Object.assign(row, { toolCall }); emit('tool_call', { step: row, toolCall });
      await step('observation', summary, { callId: call.id, ok: result.ok, errorCode: result.error?.code,
        cacheHit: Boolean(result.data?.cacheHit), hasMore: result.data?.hasMore }, toolName, evidenceIds, error ? 'error' : 'success');
    },
  };
  return {
    events, steps, modelCalls, insertStep,
    setPhase: (value) => { phase = value; },
    async modelCall(callPhase, operation) {
      phase = callPhase; activeUsage = undefined;
      const callStart = Date.now(); let error;
      try { return await operation(); } catch (failure) { error = failure; throw failure; }
      finally {
        const call = { callIndex: modelCalls.length, phase: callPhase, startedAt: callStart, finishedAt: Date.now(),
          usage: activeUsage, status: error ? 'error' : 'success', errorCode: error?.code,
          usageComplete: Number.isFinite(activeUsage?.promptTokens) && Number.isFinite(activeUsage?.completionTokens) };
        modelCalls.push(call);
        try {
          await persistLog({ ...logScope, requestKind: 'model-call', requestStartedAt: callStart, requestFinishedAt: call.finishedAt,
            status: call.status, usage: activeUsage, errorMessage: error?.message,
            payload: { phase: callPhase, callIndex: call.callIndex, usageComplete: call.usageComplete, errorCode: error?.code } });
        } catch (failure) { failure.criticalPersistence = true; throw failure; }
      }
    },
    summary() {
      const known = modelCalls.filter((c) => c.usageComplete);
      const hitCalls = modelCalls.filter((c) => Number.isFinite(c.usage?.promptTokens) && Number.isFinite(c.usage?.promptCacheHitTokens));
      const input = hitCalls.reduce((n, c) => n + c.usage.promptTokens, 0);
      return { runtime: runtimeVersion, modelCalls: modelCalls.length, observedUsageCalls: known.length,
        observedPromptTokens: known.reduce((n, c) => n + c.usage.promptTokens, 0),
        observedCompletionTokens: known.reduce((n, c) => n + c.usage.completionTokens, 0),
        cacheObservedCalls: hitCalls.length, cacheHitRatio: input > 0 ? hitCalls.reduce((n, c) => n + c.usage.promptCacheHitTokens, 0) / input : null,
        usageCoverage: modelCalls.length ? known.length / modelCalls.length : null, elapsedMs: Date.now() - startedAt };
    },
    async terminal({ status, stopReason, error, usage, payload = {} }) {
      if (terminalWritten) return;
      terminalWritten = true;
      const failedPhase = phase; phase = 'terminal';
      await step('observation', status === 'success' ? '本次文档问答已完成。' : status === 'aborted' ? '本次问答已取消。' : '本次问答未完成。',
        { terminal: true, terminalStatus: status, stopReason, failedPhase: error ? failedPhase : undefined, errorCode: error?.code,
          ...this.summary() }, undefined, [], status === 'success' ? 'success' : 'error');
      if (terminalLog) await persistLog({ ...logScope, requestKind: 'answer-stream', requestStartedAt: startedAt, requestFinishedAt: Date.now(),
        status, usage, errorMessage: error?.message, payload: { ...payload, ...this.summary(), usageAccounting: 'per-model-call', stopReason, failedPhase: error ? failedPhase : undefined } });
    },
  };
}
