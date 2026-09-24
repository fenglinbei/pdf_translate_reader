import { getModelProviderConfig } from '../models/providerConfig.mjs';
import { createModelChatBody, normalizeModelUsage } from '../models/requestBody.mjs';
import { getAvailableModelIds, requireModelDefinition, resolveQaThinking } from '../../shared/modelRegistry.mjs';
import { DocumentToolError, requireCondition } from '../qa/documents/errors.mjs';

export const NATIVE_MODEL_CANDIDATES = ['deepseek-flash', 'deepseek-v4-pro', 'qwen3.8-max', 'qwen3.8-flash'];
export function getDocumentToolModels(env = process.env) {
  const allowed = (env.QA_DOCUMENT_MODELS ?? 'deepseek-flash,deepseek-v4-pro').split(',').map((s) => s.trim());
  return getAvailableModelIds('qa').filter((id) => NATIVE_MODEL_CANDIDATES.includes(id) && allowed.includes(id));
}
export function assertDocumentToolModel(model, env = process.env) {
  requireCondition(getDocumentToolModels(env).includes(model), 'UNSUPPORTED_DOCUMENT_TOOL_MODEL', '所选模型尚未开放新版工具问答，请选择可用模型或显式使用旧执行器。', { retryable: false, statusCode: 400 });
}

export function createQaToolAdapter({ model, reasoningEffort = 'standard', fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 120000 }) {
  assertDocumentToolModel(model, env);
  const definition = requireModelDefinition(model);
  const provider = getModelProviderConfig(definition.provider, env);
  requireCondition(provider.apiKeyConfigured && provider.apiBaseUrlConfigured, 'QA_PROVIDER_NOT_CONFIGURED', '新版问答所选模型的服务配置不完整。', { retryable: false, statusCode: 503 });
  async function request({ messages, tools, signal, stream, maxTokens }) {
    signal?.throwIfAborted();
    const body = createModelChatBody({ model, messages, stream, maxTokens, temperature: 0.2,
      thinking: resolveQaThinking(model, reasoningEffort) });
    body.tools = tools;
    // Qwen thinking mode does not support tool_choice=required. A bounded
    // protocol correction handles a natural-language-only planning response.
    body.tool_choice = stream ? 'none' : 'auto';
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    let response;
    try {
      response = await fetchImpl(`${provider.apiBaseUrl}/chat/completions`, { method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: combined });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new DocumentToolError(combined.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK_ERROR', combined.aborted ? '模型调用超时。' : '模型服务连接失败。', { retryable: false, statusCode: 502 });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new DocumentToolError(`MODEL_HTTP_${response.status}`, `模型服务返回 ${response.status}。`, { retryable: false, statusCode: 502 });
    }
    return { response, combined };
  }
  return {
    provider: definition.provider,
    async complete({ messages, tools, signal, onUsage }) {
      const { response, combined } = await request({ messages, tools, signal, stream: false, maxTokens: Math.min(8192, definition.context.maxOutputTokens) });
      let payload;
      try { payload = await response.json(); }
      catch {
        signal?.throwIfAborted();
        throw new DocumentToolError(combined.aborted ? 'MODEL_TIMEOUT' : 'MODEL_INVALID_RESPONSE',
          combined.aborted ? '模型调用超时。' : '模型决策响应格式无效。', { retryable: false, statusCode: 502 });
      }
      const usage = nativeUsage(payload.usage);
      onUsage?.(usage);
      const choice = payload.choices?.[0], message = choice?.message;
      requireCondition(message?.role === 'assistant', 'MODEL_PROTOCOL_ERROR', '模型没有返回合法 assistant 消息。', { retryable: false });
      requireCondition(choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls', 'MODEL_INCOMPLETE', '模型决策未完整结束。', { retryable: false });
      const calls = message.tool_calls ?? [];
      requireCondition(Array.isArray(calls), 'MODEL_PROTOCOL_ERROR', '工具调用列表格式无效。', { retryable: false });
      const ids = new Set();
      for (const call of calls) {
        requireCondition(typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 200 && !ids.has(call.id)
          && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function?.arguments === 'string',
        'MODEL_PROTOCOL_ERROR', '工具调用缺少合法唯一 ID 或 function 数据。', { retryable: false });
        ids.add(call.id);
      }
      requireCondition(calls.length === 0 || choice.finish_reason === 'tool_calls', 'MODEL_PROTOCOL_ERROR', '工具调用结束原因无效。', { retryable: false });
      // Keep the complete assistant message, including provider-required
      // reasoning_content, only in this request's memory. Never persist it.
      return { message: structuredClone(message), calls: calls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), usage };
    },
    async stream({ messages, tools, signal, onDelta, onUsage }) {
      const { response } = await request({ messages, tools, signal, stream: true, maxTokens: Math.min(16384, definition.context.maxOutputTokens) });
      requireCondition(response.body, 'MODEL_STREAM_MISSING', '模型流缺少响应体。', { retryable: false });
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', finishReason, hasContent = false;
      const processLine = (line) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        let frame;
        try { frame = JSON.parse(data); } catch { throw new DocumentToolError('MODEL_INVALID_STREAM', '模型流数据格式无效。', { retryable: false }); }
        requireCondition(!frame.error, 'MODEL_STREAM_ERROR', '模型流返回错误。', { retryable: false });
        if (frame.usage) onUsage?.(nativeUsage(frame.usage));
        const choice = frame.choices?.[0];
        requireCondition(!choice?.delta?.tool_calls?.length, 'MODEL_PROTOCOL_ERROR', '答案阶段不允许新工具调用。', { retryable: false });
        if (typeof choice?.delta?.content === 'string') { hasContent ||= Boolean(choice.delta.content.trim()); onDelta?.(choice.delta.content); }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
      };
      try {
        while (true) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          requireCondition(buffer.length < 1024 * 1024, 'MODEL_INVALID_STREAM', '模型流帧超过上限。', { retryable: false });
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
          for (const line of lines) processLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) processLine(buffer);
        requireCondition(finishReason === 'stop' && hasContent, 'MODEL_INCOMPLETE', '模型答案未正常完成或正文为空。', { retryable: false, statusCode: 502 });
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return { finishReason };
    },
  };
}
function nativeUsage(usage) {
  const normalized = normalizeModelUsage(usage);
  return { ...normalized, promptCacheCreationTokens: Number.isFinite(usage?.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : undefined };
}
