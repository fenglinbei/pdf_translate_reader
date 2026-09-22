import { requireModelDefinition } from "../../shared/modelRegistry.mjs";

// Shared wire adapter for translation and QA. Callers choose the task's
// reasoning policy; provider-specific field names and restrictions live here.
export function createModelChatBody({
  model, messages, stream = true, thinking, temperature, maxTokens,
  deterministic = false,
}) {
  const definition = requireModelDefinition(model);
  const profile = definition.reasoning;
  const enabled = !profile.translation.canDisable || thinking?.enabled === true;
  const effort = thinking?.effort ?? profile.qa.standard.effort;
  if (enabled && effort && !profile.providerEfforts.includes(effort)) {
    throw new Error(`Unsupported reasoning effort for ${model}: ${effort}`);
  }
  const body = { messages, model: definition.apiModel, stream };
  // Legacy GLM streams already contain usage without stream_options.
  if (stream && definition.reasoningProfile !== "glm52") {
    body.stream_options = { include_usage: true };
  }
  if (profile.toggleParameter === "enable_thinking") {
    body.enable_thinking = enabled;
  } else if (profile.toggleParameter === "thinking") {
    body.thinking = { type: enabled ? "enabled" : "disabled" };
  }
  if (enabled && effort) body.reasoning_effort = effort;
  if (definition.provider !== "kimi" && !enabled && temperature !== undefined) {
    body.temperature = temperature;
  }
  if (deterministic && definition.reasoningProfile === "glm52") body.do_sample = false;
  if (maxTokens !== undefined) {
    if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > definition.context.maxOutputTokens) {
      throw new Error(`Invalid output token limit for ${model}`);
    }
    body[definition.outputTokenParameter] = maxTokens;
  }
  return body;
}

export function normalizeModelUsage(usage = {}) {
  usage ??= {};
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    completionTokens: number(usage.completion_tokens ?? usage.completionTokens),
    promptCacheHitTokens: number(usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens),
    promptCacheMissTokens: number(usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens),
    promptTokens: number(usage.prompt_tokens ?? usage.promptTokens),
    reasoningTokens: number(usage.completion_tokens_details?.reasoning_tokens ?? usage.completionTokensDetails?.reasoningTokens),
    totalTokens: number(usage.total_tokens ?? usage.totalTokens),
  };
}
