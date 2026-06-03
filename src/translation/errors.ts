export const TRANSLATION_TIMEOUT_MESSAGE = "Translation timed out. Please try again with shorter context.";

export function getTranslationErrorMessage(error: unknown) {
  if (isAbortError(error)) {
    return "Translation was cancelled.";
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
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
