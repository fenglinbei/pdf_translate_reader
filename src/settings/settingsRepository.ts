import { getAppDb } from "../cache";
import type { ApiCallLog, AppSettings } from "../types/domain";

const APP_SETTINGS_KEY = "app";
export const MAX_DRAGGED_WORDS_LIMIT = 256;
export const MIN_DRAGGED_WORDS_LIMIT = 1;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  contextWindowN: 2,
  defaultModel: "deepseek-v4-flash",
  longContextEnabled: true,
  maxDraggedWords: 128,
  sourceLang: "en",
  targetLang: "zh",
};

export type ApiUsageSummary = {
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  errorCalls: number;
  promptTokens: number;
  recentLogs: ApiCallLog[];
  successfulCalls: number;
  totalCalls: number;
  totalTokens: number;
};

export async function getAppSettings() {
  const db = await getAppDb();
  const storedSettings = await db.get("settings", APP_SETTINGS_KEY);

  return normalizeAppSettings(storedSettings);
}

export async function putAppSettings(input: Partial<AppSettings>) {
  const db = await getAppDb();
  const currentSettings = normalizeAppSettings(await db.get("settings", APP_SETTINGS_KEY));
  const nextSettings = normalizeAppSettings({
    ...currentSettings,
    ...input,
  });

  await db.put("settings", nextSettings, APP_SETTINGS_KEY);

  return nextSettings;
}

export async function getApiUsageSummary(pdfFingerprint?: string): Promise<ApiUsageSummary> {
  const db = await getAppDb();
  const logs = pdfFingerprint
    ? await db.getAllFromIndex("apiLogs", "by-pdf", pdfFingerprint)
    : await db.getAll("apiLogs");

  return summarizeApiLogs(logs);
}

export function normalizeAppSettings(input: unknown): AppSettings {
  const value = isRecord(input) ? input : {};
  const contextWindowN = [0, 1, 2, 3, 5].includes(Number(value.contextWindowN))
    ? (Number(value.contextWindowN) as AppSettings["contextWindowN"])
    : DEFAULT_APP_SETTINGS.contextWindowN;
  const defaultModel =
    value.defaultModel === "deepseek-v4-pro" || value.defaultModel === "deepseek-v4-flash"
      ? value.defaultModel
      : DEFAULT_APP_SETTINGS.defaultModel;
  const maxDraggedWords = clamp(
    Number(value.maxDraggedWords) || DEFAULT_APP_SETTINGS.maxDraggedWords,
    MIN_DRAGGED_WORDS_LIMIT,
    MAX_DRAGGED_WORDS_LIMIT,
  );

  return {
    contextWindowN,
    defaultModel,
    longContextEnabled:
      typeof value.longContextEnabled === "boolean"
        ? value.longContextEnabled
        : DEFAULT_APP_SETTINGS.longContextEnabled,
    maxDraggedWords,
    sourceLang: "en",
    targetLang: "zh",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function summarizeApiLogs(logs: ApiCallLog[]): ApiUsageSummary {
  const recentLogs = logs
    .slice()
    .sort((left, right) => right.requestStartedAt - left.requestStartedAt)
    .slice(0, 6);

  return {
    cacheHitTokens: sum(logs, "promptCacheHitTokens"),
    cacheMissTokens: sum(logs, "promptCacheMissTokens"),
    completionTokens: sum(logs, "completionTokens"),
    errorCalls: logs.filter((log) => log.status === "error").length,
    promptTokens: sum(logs, "promptTokens"),
    recentLogs,
    successfulCalls: logs.filter((log) => log.status === "success").length,
    totalCalls: logs.length,
    totalTokens: sum(logs, "totalTokens"),
  };
}

function sum(logs: ApiCallLog[], key: keyof ApiCallLog) {
  return logs.reduce((total, log) => {
    const value = log[key];

    return typeof value === "number" ? total + value : total;
  }, 0);
}
