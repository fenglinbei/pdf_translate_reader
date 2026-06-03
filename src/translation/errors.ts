export const TRANSLATION_TIMEOUT_MESSAGE = "Translation timed out. Please try again with shorter context.";

export class TranslationTimeoutError extends Error {
  constructor(message = TRANSLATION_TIMEOUT_MESSAGE) {
    super(message);
    this.name = "TranslationTimeoutError";
  }
}

export class TranslationNetworkError extends Error {
  constructor(message = "Network connection failed. Check the API proxy and internet connection.") {
    super(message);
    this.name = "TranslationNetworkError";
  }
}

export function getTranslationErrorMessage(error: unknown) {
  if (error instanceof TranslationTimeoutError || error instanceof TranslationNetworkError) {
    return error.message;
  }

  if (isAbortError(error)) {
    return "Translation was cancelled.";
  }

  if (error instanceof Error && error.message.trim()) {
    return normalizeTranslationErrorMessage(error.message);
  }

  return "Translation failed.";
}

export function getStorageErrorMessage(error: unknown, fallback: string) {
  if (isQuotaExceededError(error)) {
    return "Browser storage is full. Clear local PDFs or translation cache, then try again.";
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallback;
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function isQuotaExceededError(error: unknown) {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function normalizeTranslationErrorMessage(message: string) {
  const normalizedMessage = message.trim();
  const lowerMessage = normalizedMessage.toLocaleLowerCase();

  if (
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes(" 429") ||
    lowerMessage.includes("quota")
  ) {
    return "DeepSeek rate limit or quota was reached. Wait a moment, then try again.";
  }

  if (
    lowerMessage.includes("network") ||
    lowerMessage.includes("failed to fetch") ||
    lowerMessage.includes("connection") ||
    lowerMessage.includes("econnreset") ||
    lowerMessage.includes("enotfound")
  ) {
    return "Network connection failed. Check the API proxy and internet connection.";
  }

  if (lowerMessage.includes("api key") || lowerMessage.includes("unauthorized") || lowerMessage.includes(" 401")) {
    return "DeepSeek API key is missing or invalid. Check the local API configuration.";
  }

  return normalizedMessage;
}
