export class DocumentToolError extends Error {
  constructor(code, message, { retryable = true, statusCode = 400, details } = {}) {
    super(message);
    this.name = 'DocumentToolError';
    Object.assign(this, { code, retryable, statusCode, details });
  }
}
export function requireCondition(condition, code, message, options) {
  if (!condition) throw new DocumentToolError(code, message, options);
}
