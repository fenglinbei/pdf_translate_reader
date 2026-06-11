import { getAppDb } from "../cache";
import { listCloudApiCallLogs } from "../cloud/apiLogCloudRepository";
import { getCloudSettings, putCloudSettings } from "../cloud/settingsCloudRepository";
import { runCloudSync } from "../cloud/syncStatus";
import { PROJECT_CONFIG } from "../config/projectConfig";
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  normalizeTranslationLanguagePair,
} from "../config/translationLanguages";
import { detectBrowserUiLocale, normalizeUiLocale } from "../i18n/uiLocales";
import type { ApiCallLog, AppSettings, TranslationModel } from "../types/domain";

const APP_SETTINGS_KEY = "app";
export const MAX_DRAGGED_WORDS_LIMIT = PROJECT_CONFIG.selection.maxDraggedWordsLimit;
export const MIN_DRAGGED_WORDS_LIMIT = PROJECT_CONFIG.selection.minDraggedWordsLimit;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  contextWindowN: 2,
  defaultModel: "deepseek-v4-flash",
  longContextEnabled: true,
  maxDraggedWords: PROJECT_CONFIG.selection.defaultMaxDraggedWords,
  selectedTextOutputMode: "processed",
  sourceLang: DEFAULT_SOURCE_LANG,
  targetLang: DEFAULT_TARGET_LANG,
  textSelectionMode: "mathpix",
  uiLocale: detectBrowserUiLocale(),
};

export type ApiUsageSummary = {
  abortedCalls: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  errorCalls: number;
  modelCounts: Record<TranslationModel, number>;
  promptTokens: number;
  recentLogs: ApiCallLog[];
  successfulCalls: number;
  totalCalls: number;
  totalTokens: number;
};

export async function getAppSettings() {
  const db = await getAppDb();
  const cloudSettings = await getCloudSettings().catch(() => undefined);

  if (cloudSettings) {
    const normalizedCloudSettings = normalizeAppSettings(cloudSettings);

    await db.put("settings", normalizedCloudSettings, APP_SETTINGS_KEY);
    return normalizedCloudSettings;
  }

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
  await runCloudSync(() => putCloudSettings(nextSettings), {
    error: "Saved settings locally, but cloud sync failed.",
    started: "Syncing settings.",
    success: "Settings synced.",
  }).catch(() => undefined);

  return nextSettings;
}

export async function getApiUsageSummary(input: {
  cloudDocumentId?: string;
  pdfFingerprint?: string;
} = {}): Promise<ApiUsageSummary> {
  const cloudLogs = await listCloudApiCallLogs(input.cloudDocumentId).catch(() => undefined);

  if (cloudLogs) {
    return summarizeApiLogs(cloudLogs);
  }

  const db = await getAppDb();
  const logs = input.pdfFingerprint
    ? await db.getAllFromIndex("apiLogs", "by-pdf", input.pdfFingerprint)
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
  const { sourceLang, targetLang } = normalizeTranslationLanguagePair(
    value.sourceLang,
    value.targetLang,
  );

  return {
    contextWindowN,
    defaultModel,
    longContextEnabled:
      typeof value.longContextEnabled === "boolean"
        ? value.longContextEnabled
        : DEFAULT_APP_SETTINGS.longContextEnabled,
    maxDraggedWords,
    selectedTextOutputMode:
      value.selectedTextOutputMode === "native" || value.selectedTextOutputMode === "processed"
        ? value.selectedTextOutputMode
        : DEFAULT_APP_SETTINGS.selectedTextOutputMode,
    sourceLang,
    targetLang,
    textSelectionMode:
      value.textSelectionMode === "original" || value.textSelectionMode === "mathpix"
        ? value.textSelectionMode
        : DEFAULT_APP_SETTINGS.textSelectionMode,
    uiLocale: normalizeUiLocale(value.uiLocale, DEFAULT_APP_SETTINGS.uiLocale),
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
    abortedCalls: logs.filter((log) => log.status === "aborted").length,
    cacheHitTokens: sum(logs, "promptCacheHitTokens"),
    cacheMissTokens: sum(logs, "promptCacheMissTokens"),
    completionTokens: sum(logs, "completionTokens"),
    errorCalls: logs.filter((log) => log.status === "error").length,
    modelCounts: {
      "deepseek-v4-flash": logs.filter((log) => log.model === "deepseek-v4-flash").length,
      "deepseek-v4-pro": logs.filter((log) => log.model === "deepseek-v4-pro").length,
    },
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
