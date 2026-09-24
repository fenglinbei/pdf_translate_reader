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
    // Keep the provider's serialized tool prefix stable through the final turn.
    // The harness closes execution after finish_reading, not tool_choice=none.
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
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
    async complete({ messages, tools, signal, onUsage, onDelta }) {
      const { response, combined } = await request({ messages, tools, signal, stream: Boolean(onDelta), maxTokens: Math.min(8192, definition.context.maxOutputTokens) });
      if (onDelta) return readToolStream(response, { signal, onDelta, onUsage });
      let payload;
      try { payload = await response.json(); }
      catch {
        signal?.throwIfAborted();
        throw new DocumentToolError(combined.aborted ? 'MODEL_TIMEOUT' : 'MODEL_INVALID_RESPONSE',
          combined.aborted ? '模型调用超时。' : '模型决策响应格式无效。', { retryable: false, statusCode: 502 });
      }
      const usage = nativeUsage(payload.usage);
      onUsage?.(usage);
      return normalizeCompletion(payload.choices?.[0]?.message, payload.choices?.[0]?.finish_reason, usage);
    },
    async stream({ messages, tools, signal, onDelta, onUsage }) {
      const { response } = await request({ messages, tools, signal, stream: true, maxTokens: Math.min(16384, definition.context.maxOutputTokens) });
      return readToolStream(response, { signal, onDelta, onUsage });
    },
  };
}
function normalizeCompletion(message, finishReason, usage) {
  requireCondition(message?.role === 'assistant', 'MODEL_PROTOCOL_ERROR', '模型没有返回合法 assistant 消息。', { retryable: false });
  requireCondition(finishReason === 'stop' || finishReason === 'tool_calls', 'MODEL_INCOMPLETE', '模型回复未完整结束。', { retryable: false });
  const calls = message.tool_calls ?? [];
  requireCondition(Array.isArray(calls) && calls.length <= 32, 'MODEL_PROTOCOL_ERROR', '工具调用列表格式或长度无效。', { retryable: false });
  const ids = new Set();
  for (const call of calls) {
    requireCondition(typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 200 && !ids.has(call.id)
      && call.type === 'function' && typeof call.function?.name === 'string' && call.function.name.length > 0 && call.function.name.length <= 100
      && typeof call.function?.arguments === 'string' && call.function.arguments.length <= 65536,
    'MODEL_PROTOCOL_ERROR', '工具调用缺少合法唯一 ID 或 function 数据。', { retryable: false });
    ids.add(call.id);
  }
  requireCondition((calls.length > 0) === (finishReason === 'tool_calls'), 'MODEL_PROTOCOL_ERROR', '工具调用结束原因无效。', { retryable: false });
  requireCondition(calls.length || typeof message.content === 'string' && message.content.trim(), 'MODEL_INCOMPLETE', '模型正文为空。', { retryable: false });
  // Complete provider continuation (including reasoning) stays in run memory only.
  return { message: structuredClone(message), calls: calls.map(c => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })), usage, finishReason };
}

async function readToolStream(response, { signal, onDelta, onUsage }) {
  requireCondition(response.body, 'MODEL_STREAM_MISSING', '模型流缺少响应体。', { retryable: false });
  const reader = response.body.getReader(), decoder = new TextDecoder(), calls = new Map();
  const message = { role: 'assistant', content: '', reasoning_content: '' };
  let buffer = '', finishReason, usage, accumulatedChars = 0;
  const processLine = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let frame;
    try { frame = JSON.parse(data); } catch { throw new DocumentToolError('MODEL_INVALID_STREAM', '模型流数据格式无效。', { retryable: false }); }
    requireCondition(!frame.error, 'MODEL_STREAM_ERROR', '模型流返回错误。', { retryable: false });
    if (frame.usage) { usage = nativeUsage(frame.usage); onUsage?.(usage); }
    const choice = frame.choices?.[0], delta = choice?.delta;
    for (const field of ['content', 'reasoning_content']) {
      if (typeof delta?.[field] !== 'string') continue;
      accumulatedChars += delta[field].length;
      requireCondition(accumulatedChars <= 512 * 1024, 'MODEL_INVALID_STREAM', '模型流累计内容超过上限。', { retryable: false });
      message[field] += delta[field];
      if (field === 'content') onDelta?.(delta[field]);
    }
    requireCondition(delta?.tool_calls === undefined || Array.isArray(delta.tool_calls), 'MODEL_PROTOCOL_ERROR', '工具增量格式无效。', { retryable: false });
    for (const item of delta?.tool_calls ?? []) {
      requireCondition(Number.isInteger(item.index) && item.index >= 0 && item.index < 32, 'MODEL_PROTOCOL_ERROR', '工具增量缺少合法 index。', { retryable: false });
      let call = calls.get(item.index);
      if (!call) { call = { id: '', type: 'function', function: { name: '', arguments: '' } }; calls.set(item.index, call); }
      if (item.type !== undefined) requireCondition(item.type === 'function', 'MODEL_PROTOCOL_ERROR', '工具类型无效。', { retryable: false });
      for (const [target, key, value, limit] of [[call, 'id', item.id, 200], [call.function, 'name', item.function?.name, 100], [call.function, 'arguments', item.function?.arguments, 65536]]) {
        if (value === undefined || value === null) continue;
        requireCondition(typeof value === 'string', 'MODEL_PROTOCOL_ERROR', '工具增量字段无效。', { retryable: false });
        target[key] += value;
        requireCondition(target[key].length <= limit, 'MODEL_PROTOCOL_ERROR', '工具增量超过上限。', { retryable: false });
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      requireCondition(buffer.length < 1024 * 1024, 'MODEL_INVALID_STREAM', '模型流帧超过上限。', { retryable: false });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? '';
      for (const line of lines) processLine(line);
    }
    buffer += decoder.decode(); if (buffer.trim()) processLine(buffer);
    if (calls.size) message.tool_calls = [...calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    return normalizeCompletion(message, finishReason, usage);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function nativeUsage(usage) {
  const normalized = normalizeModelUsage(usage);
  return { ...normalized, promptCacheCreationTokens: Number.isFinite(usage?.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : undefined };
}
