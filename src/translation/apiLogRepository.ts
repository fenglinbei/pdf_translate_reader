import { getAppDb } from "../cache";
import { putCloudApiCallLog } from "../cloud/apiLogCloudRepository";
import { runCloudSync } from "../cloud/syncStatus";
import type { ApiCallLog, TokenUsage, TranslationRequest } from "../types/domain";

export const API_LOGS_UPDATED_EVENT = "pdf-translate-reader:api-logs-updated";

export type ApiCallLogWriteInput = {
  errorMessage?: string;
  request: TranslationRequest;
  requestFinishedAt?: number;
  requestStartedAt: number;
  status: ApiCallLog["status"];
  usage?: TokenUsage;
};

export async function putApiCallLog(input: ApiCallLogWriteInput) {
  const db = await getAppDb();
  const log: ApiCallLog = {
    cloudDocumentId: input.request.cloudDocumentId,
    completionTokens: input.usage?.completionTokens,
    contextWindowN: input.request.contextWindowN,
    errorMessage: input.errorMessage,
    id: createApiCallLogId(input.requestStartedAt),
    longContextEnabled: input.request.longContextEnabled,
    model: input.request.model,
    pdfFingerprint: input.request.pdfFingerprint,
    promptCacheHitTokens: input.usage?.promptCacheHitTokens,
    promptCacheMissTokens: input.usage?.promptCacheMissTokens,
    promptTokens: input.usage?.promptTokens,
    promptVersion: input.request.promptVersion,
    requestKind: input.request.requestKind,
    requestFinishedAt: input.requestFinishedAt,
    requestStartedAt: input.requestStartedAt,
    sourceLang: input.request.sourceLang,
    status: input.status,
    targetLang: input.request.targetLang,
    textSource: input.request.textSource,
    mathpixOptionsHash: input.request.mathpixOptionsHash,
    totalTokens: input.usage?.totalTokens,
    translationStyle: input.request.translationStyle,
    translationStyleHash: input.request.translationStyleHash,
  };

  await db.put("apiLogs", log);
  await runCloudSync(() => putCloudApiCallLog(log), {
    error: "Saved API log locally, but cloud sync failed.",
    started: "Syncing API log.",
    success: "API log synced.",
  }).catch(() => undefined);
  window.dispatchEvent(new CustomEvent(API_LOGS_UPDATED_EVENT));

  return log;
}

function createApiCallLogId(startedAt: number) {
  return `api-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
}
