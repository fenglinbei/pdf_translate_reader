import type { QaApiLog } from '../types/domain';

// A terminal record retains the final answer usage for history. New runtimes
// also record that same call separately, so it must not be charged twice.
export function qaLogsForUsage(logs: QaApiLog[]): QaApiLog[] {
  const trackedMessages = new Set(logs.filter(log => log.requestKind === 'model-call' && log.messageId).map(log => log.messageId));
  return logs.filter(log => log.requestKind !== 'answer-stream' || !(trackedMessages.has(log.messageId)
    || (log.payload && typeof log.payload === 'object' && 'usageAccounting' in log.payload && log.payload.usageAccounting === 'per-model-call')));
}
