// Model context window configuration and token-aware budget allocation.
//
// Both supported QA models (deepseek-v4-pro, glm-5.2) expose a 1M-token
// context window. This module computes per-section character budgets so the
// prompt builder can scale evidence / full-text / conversation inputs to fill
// the window instead of relying on the old fixed 240k-char ceiling.

export const MODEL_CONTEXT_CONFIG = {
  "deepseek-v4-pro": {
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    defaultMaxTokens: 32768,
  },
  "glm-5.2": {
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
    defaultMaxTokens: 32768,
  },
};

export const FALLBACK_MODEL = "glm-5.2";

// Tokens reserved for the model's answer + reasoning output. Both models can
// produce very long thinking traces; we keep a generous slice so the answer is
// never truncated by the input filling the window.
const OUTPUT_RESERVE_TOKENS = 65_536;
const SYSTEM_PROMPT_RESERVE_TOKENS = 4096;
// In long-context mode, reserve room for conversation context, the question,
// and the prompt scaffolding around the full paper text.
const LONG_CONTEXT_EXTRAS_RESERVE_TOKENS = 60_000;

// Conservative chars-per-token estimate for mixed academic text (English +
// LaTeX + CJK). 3.0 errs on the side of under-counting tokens so budgets stay
// safe; this is more conservative than the old length/3.5 heuristic.
const CHARS_PER_TOKEN = 3.0;

export function getModelContextConfig(model) {
  return MODEL_CONTEXT_CONFIG[model] ?? MODEL_CONTEXT_CONFIG[FALLBACK_MODEL];
}

export function estimateTokens(text) {
  const length = typeof text === "string" ? text.length : 0;
  return Math.ceil(length / CHARS_PER_TOKEN);
}

export function tokensToChars(tokens) {
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

/**
 * Compute per-section character budgets for a QA answer prompt.
 *
 * @param {object} input
 * @param {string} input.model - Normalized chat model id.
 * @param {"answer"|"direct"|"long_context"} input.mode - Prompt mode.
 * @returns {{
 *   fullPaperTextChars: number,
 *   evidencePackChars: number,
 *   perEvidenceChars: number,
 *   conversationContextChars: number,
 *   perMessageChars: number,
 *   questionChars: number,
 *   contextWindow: number,
 *   availableInputTokens: number,
 * }}
 */
export function computeAnswerContextBudget({ model, mode = "answer" }) {
  const config = getModelContextConfig(model);
  const availableInputTokens =
    config.contextWindow - OUTPUT_RESERVE_TOKENS - SYSTEM_PROMPT_RESERVE_TOKENS;

  // Conversation / question budgets scale with the window but stay bounded so
  // they never dominate the prompt.
  const conversationContextChars = Math.min(
    tokensToChars(40_000),
    tokensToChars(Math.floor(availableInputTokens * 0.1)),
  );
  const perMessageChars = Math.min(
    tokensToChars(4_000),
    conversationContextChars,
  );
  const questionChars = tokensToChars(8_000);

  if (mode === "long_context") {
    const fullPaperTokens =
      availableInputTokens - LONG_CONTEXT_EXTRAS_RESERVE_TOKENS;
    return {
      fullPaperTextChars: Math.max(tokensToChars(fullPaperTokens), 240_000),
      evidencePackChars: 0,
      perEvidenceChars: 0,
      conversationContextChars,
      perMessageChars,
      questionChars,
      contextWindow: config.contextWindow,
      availableInputTokens,
    };
  }

  // answer / direct modes: evidence pack gets the bulk of the window.
  const evidencePackTokens = Math.floor(availableInputTokens * 0.7);
  return {
    fullPaperTextChars: 0,
    evidencePackChars: tokensToChars(evidencePackTokens),
    perEvidenceChars: 6_000,
    conversationContextChars,
    perMessageChars,
    questionChars,
    contextWindow: config.contextWindow,
    availableInputTokens,
  };
}

/**
 * Default max_tokens to send in the completion request body.
 * Bounds the generated answer length so it cannot run away.
 */
export function getModelMaxTokens(model) {
  return getModelContextConfig(model).defaultMaxTokens;
}
