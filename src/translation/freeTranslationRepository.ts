import { getAppDb } from "../cache";
import {
  DEFAULT_SOURCE_LANG,
  DEFAULT_TARGET_LANG,
  isTranslationLanguage,
} from "../config/translationLanguages";
import type {
  FreeTranslationDraft,
  FreeTranslationRecord,
  FreeTranslationRequestSnapshot,
  FreeTranslationSourceLanguage,
  FreeTranslationTerminologyEntry,
  TokenUsage,
  TranslationModel,
  TranslationReasoningEffort,
} from "../types/domain";
import { isTranslationModel } from "./models";
import {
  getTranslationStyleHash,
  normalizeTranslationStyle,
} from "./translationStyle";

const FREE_TRANSLATION_SCHEMA_VERSION = 1 as const;
const DEFAULT_TRANSLATION_MODEL: TranslationModel = "deepseek-v4-flash";
const FREE_TRANSLATION_REASONING_SUMMARY_MAX_CHARACTERS = 1_200;

export const DEFAULT_FREE_TRANSLATION_HISTORY_LIMIT = 20;
export const FREE_TRANSLATION_HISTORY_MAX_ENTRIES = 50;
export const FREE_TRANSLATION_HISTORY_MAX_CHARACTERS = 1_000_000;

export type FreeTranslationDraftWriteInput = Omit<
  FreeTranslationDraft,
  "schemaVersion" | "updatedAt"
> & {
  updatedAt?: number;
};

export type FreeTranslationRecordWriteInput = Omit<
  FreeTranslationRecord,
  "schemaVersion" | "id" | "createdAt" | "updatedAt"
> & {
  createdAt?: number;
};

export type FreeTranslationHistoryPolicy = {
  maxCharacters: number;
  maxEntries: number;
};

export const DEFAULT_FREE_TRANSLATION_HISTORY_POLICY: FreeTranslationHistoryPolicy = {
  maxCharacters: FREE_TRANSLATION_HISTORY_MAX_CHARACTERS,
  maxEntries: FREE_TRANSLATION_HISTORY_MAX_ENTRIES,
};

export async function getFreeTranslationDraft(userId: string) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const db = await getAppDb();
  const storedDraft = await db.get("freeTranslationDrafts", normalizedUserId);

  return normalizeFreeTranslationDraft(storedDraft, normalizedUserId);
}

export async function putFreeTranslationDraft(input: FreeTranslationDraftWriteInput) {
  const draft = createFreeTranslationDraft(input);
  const db = await getAppDb();

  await db.put("freeTranslationDrafts", draft);

  return draft;
}

export async function deleteFreeTranslationDraft(userId: string) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const db = await getAppDb();

  await db.delete("freeTranslationDrafts", normalizedUserId);
}

export async function listFreeTranslationHistory(
  userId: string,
  options: { limit?: number } = {},
) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const limit = normalizePositiveInteger(
    options.limit,
    DEFAULT_FREE_TRANSLATION_HISTORY_LIMIT,
    FREE_TRANSLATION_HISTORY_MAX_ENTRIES,
  );
  const db = await getAppDb();
  const storedRecords = await db.getAllFromIndex(
    "freeTranslationHistory",
    "by-user",
    normalizedUserId,
  );

  return storedRecords
    .map((record) => normalizeFreeTranslationRecord(record, normalizedUserId))
    .filter((record): record is FreeTranslationRecord => Boolean(record))
    .sort(compareFreeTranslationRecordsNewestFirst)
    .slice(0, limit);
}

export async function getFreeTranslationRecord(userId: string, recordId: string) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const normalizedRecordId = requireNonEmptyString(recordId, "recordId");
  const db = await getAppDb();
  const storedRecord = await db.get("freeTranslationHistory", normalizedRecordId);

  return normalizeFreeTranslationRecord(storedRecord, normalizedUserId);
}

export async function putFreeTranslationRecord(
  input: FreeTranslationRecordWriteInput,
  policy: Partial<FreeTranslationHistoryPolicy> = {},
) {
  const record = createFreeTranslationRecord(input);
  const normalizedPolicy = normalizeFreeTranslationHistoryPolicy(policy);
  const db = await getAppDb();
  const transaction = db.transaction("freeTranslationHistory", "readwrite");

  await transaction.store.put(record);
  const userRecords = await transaction.store.index("by-user").getAll(record.userId);
  const recordIdsToDelete = selectFreeTranslationHistoryIdsToDelete(
    userRecords,
    normalizedPolicy,
  );

  await Promise.all(recordIdsToDelete.map((recordId) => transaction.store.delete(recordId)));
  await transaction.done;

  return record;
}

export async function deleteFreeTranslationRecord(userId: string, recordId: string) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const normalizedRecordId = requireNonEmptyString(recordId, "recordId");
  const db = await getAppDb();
  const storedRecord = await db.get("freeTranslationHistory", normalizedRecordId);

  if (storedRecord?.userId !== normalizedUserId) {
    return false;
  }

  await db.delete("freeTranslationHistory", normalizedRecordId);
  return true;
}

export async function clearFreeTranslationHistory(userId: string) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const db = await getAppDb();
  const transaction = db.transaction("freeTranslationHistory", "readwrite");
  const keys = await transaction.store.index("by-user").getAllKeys(normalizedUserId);

  await Promise.all(keys.map((key) => transaction.store.delete(key)));
  await transaction.done;

  return keys.length;
}

export async function pruneFreeTranslationHistory(
  userId: string,
  policy: Partial<FreeTranslationHistoryPolicy> = {},
) {
  const normalizedUserId = requireNonEmptyString(userId, "userId");
  const normalizedPolicy = normalizeFreeTranslationHistoryPolicy(policy);
  const db = await getAppDb();
  const transaction = db.transaction("freeTranslationHistory", "readwrite");
  const records = await transaction.store.index("by-user").getAll(normalizedUserId);
  const recordIdsToDelete = selectFreeTranslationHistoryIdsToDelete(
    records,
    normalizedPolicy,
  );

  await Promise.all(recordIdsToDelete.map((recordId) => transaction.store.delete(recordId)));
  await transaction.done;

  return recordIdsToDelete.length;
}

export function createFreeTranslationDraft(
  input: FreeTranslationDraftWriteInput,
): FreeTranslationDraft {
  const sourceLang = normalizeFreeTranslationSourceLanguage(input.sourceLang);
  const targetLang = isTranslationLanguage(input.targetLang)
    ? input.targetLang
    : DEFAULT_TARGET_LANG;
  const model = normalizeTranslationModel(input.model);

  return {
    includePaperContext: Boolean(input.includePaperContext),
    model,
    pdfFingerprint: normalizeOptionalString(input.pdfFingerprint),
    pdfTitle: normalizeOptionalString(input.pdfTitle),
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
    reasoningEnabled: normalizeReasoningEnabled(input.reasoningEnabled, model),
    schemaVersion: FREE_TRANSLATION_SCHEMA_VERSION,
    sourceLang,
    sourceText: normalizeText(input.sourceText),
    targetLang,
    terminology: normalizeTerminology(input.terminology, false),
    translationStyle: normalizeTranslationStyle(input.translationStyle),
    updatedAt: normalizeTimestamp(input.updatedAt),
    userId: requireNonEmptyString(input.userId, "userId"),
  };
}

export function createFreeTranslationRecord(
  input: FreeTranslationRecordWriteInput,
): FreeTranslationRecord {
  const userId = requireNonEmptyString(input.userId, "userId");
  const sourceText = requireTextContent(input.sourceText, "sourceText");
  const translation = requireTextContent(input.translation, "translation");
  const createdAt = normalizeTimestamp(input.createdAt);

  return {
    cloudDocumentId: normalizeOptionalString(input.cloudDocumentId),
    createdAt,
    id: createFreeTranslationRecordId(createdAt),
    pdfFingerprint: normalizeOptionalString(input.pdfFingerprint),
    pdfTitle: normalizeOptionalString(input.pdfTitle),
    reasoningSummary: normalizeReasoningSummary(input.reasoningSummary),
    request: normalizeFreeTranslationRequestSnapshot(input.request),
    schemaVersion: FREE_TRANSLATION_SCHEMA_VERSION,
    sourceText,
    translation,
    updatedAt: createdAt,
    usage: normalizeTokenUsage(input.usage),
    userId,
  };
}

export function selectFreeTranslationHistoryIdsToDelete(
  records: FreeTranslationRecord[],
  policy: FreeTranslationHistoryPolicy = DEFAULT_FREE_TRANSLATION_HISTORY_POLICY,
) {
  const normalizedPolicy = normalizeFreeTranslationHistoryPolicy(policy);
  const newestFirst = records.slice().sort(compareFreeTranslationRecordsNewestFirst);
  const idsToDelete = new Set<string>();
  let retainedCharacters = 0;
  let retentionClosed = false;

  newestFirst.forEach((record, index) => {
    const wouldExceedEntryLimit = index >= normalizedPolicy.maxEntries;
    const recordCharacters = getFreeTranslationRecordCharacterCount(record);
    const wouldExceedCharacterLimit =
      index > 0 &&
      retainedCharacters + recordCharacters > normalizedPolicy.maxCharacters;

    if (retentionClosed || wouldExceedEntryLimit || wouldExceedCharacterLimit) {
      idsToDelete.add(record.id);
      retentionClosed = true;
      return;
    }

    retainedCharacters += recordCharacters;
  });

  return Array.from(idsToDelete);
}

export function getFreeTranslationRecordCharacterCount(record: FreeTranslationRecord) {
  const terminologyCharacters = record.request.terminology.reduce(
    (total, term) => total + term.source.length + term.target.length,
    0,
  );

  return record.sourceText.length +
    record.translation.length +
    (record.reasoningSummary?.length ?? 0) +
    (record.request.translationStyle.customInstruction?.length ?? 0) +
    terminologyCharacters;
}

function normalizeFreeTranslationDraft(
  input: unknown,
  expectedUserId: string,
): FreeTranslationDraft | undefined {
  if (!isRecord(input) || input.userId !== expectedUserId) {
    return undefined;
  }

  const model = normalizeTranslationModel(input.model);

  return createFreeTranslationDraft({
    includePaperContext: input.includePaperContext === true,
    model,
    pdfFingerprint: normalizeOptionalString(input.pdfFingerprint),
    pdfTitle: normalizeOptionalString(input.pdfTitle),
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
    reasoningEnabled: normalizeReasoningEnabled(input.reasoningEnabled, model),
    sourceLang: normalizeFreeTranslationSourceLanguage(input.sourceLang),
    sourceText: normalizeText(input.sourceText),
    targetLang: isTranslationLanguage(input.targetLang)
      ? input.targetLang
      : DEFAULT_TARGET_LANG,
    terminology: normalizeTerminology(input.terminology, false),
    translationStyle: normalizeTranslationStyle(input.translationStyle),
    updatedAt: normalizeTimestamp(input.updatedAt),
    userId: expectedUserId,
  });
}

function normalizeFreeTranslationRecord(
  input: unknown,
  expectedUserId: string,
): FreeTranslationRecord | undefined {
  if (
    !isRecord(input) ||
    input.userId !== expectedUserId ||
    typeof input.id !== "string" ||
    !input.id ||
    typeof input.sourceText !== "string" ||
    !input.sourceText.trim() ||
    typeof input.translation !== "string" ||
    !input.translation.trim() ||
    !isRecord(input.request)
  ) {
    return undefined;
  }

  const createdAt = normalizeTimestamp(input.createdAt);

  return {
    cloudDocumentId: normalizeOptionalString(input.cloudDocumentId),
    createdAt,
    id: input.id,
    pdfFingerprint: normalizeOptionalString(input.pdfFingerprint),
    pdfTitle: normalizeOptionalString(input.pdfTitle),
    reasoningSummary: normalizeReasoningSummary(input.reasoningSummary),
    request: normalizeFreeTranslationRequestSnapshot(input.request),
    schemaVersion: FREE_TRANSLATION_SCHEMA_VERSION,
    sourceText: input.sourceText,
    translation: input.translation,
    updatedAt: normalizeTimestamp(input.updatedAt, createdAt),
    usage: normalizeTokenUsage(input.usage),
    userId: expectedUserId,
  };
}

function normalizeFreeTranslationRequestSnapshot(
  input: FreeTranslationRequestSnapshot | Record<string, unknown>,
): FreeTranslationRequestSnapshot {
  const translationStyle = normalizeTranslationStyle(input.translationStyle);
  const model = normalizeTranslationModel(input.model);

  return {
    includePaperContext: input.includePaperContext === true,
    model,
    paperContextHash: normalizeOptionalString(input.paperContextHash),
    promptVersion: normalizeOptionalString(input.promptVersion) ?? "unknown",
    reasoningEffort: normalizeReasoningEffort(input.reasoningEffort, model),
    reasoningEnabled: normalizeReasoningEnabled(input.reasoningEnabled, model),
    sourceLang: normalizeFreeTranslationSourceLanguage(input.sourceLang),
    targetLang: isTranslationLanguage(input.targetLang)
      ? input.targetLang
      : DEFAULT_TARGET_LANG,
    terminology: normalizeTerminology(input.terminology, true),
    translationStyle,
    translationStyleHash:
      normalizeOptionalString(input.translationStyleHash) ??
      getTranslationStyleHash(translationStyle),
  };
}

function normalizeFreeTranslationSourceLanguage(
  value: unknown,
): FreeTranslationSourceLanguage {
  return value === "auto" || isTranslationLanguage(value)
    ? value
    : DEFAULT_SOURCE_LANG;
}

function normalizeTranslationModel(value: unknown): TranslationModel {
  return isTranslationModel(value) ? value : DEFAULT_TRANSLATION_MODEL;
}

function normalizeReasoningEnabled(value: unknown, model: TranslationModel) {
  if (model === "kimi-k3") {
    return true;
  }

  return typeof value === "boolean" ? value : false;
}

function normalizeReasoningEffort(
  value: unknown,
  model: TranslationModel,
): TranslationReasoningEffort {
  const defaultEffort = model === "kimi-k3" ? "max" : "high";
  const normalizedEffort = value === "low" || value === "high" || value === "max"
    ? value
    : defaultEffort;

  return model !== "kimi-k3" && normalizedEffort === "low"
    ? "high"
    : normalizedEffort;
}

function normalizeTerminology(value: unknown, omitIncomplete: boolean) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((term): FreeTranslationTerminologyEntry => ({
      source: normalizeText(term.source),
      target: normalizeText(term.target),
    }))
    .filter((term) => !omitIncomplete || Boolean(term.source.trim() && term.target.trim()));
}

function normalizeTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage: TokenUsage = {
    completionTokens: normalizeOptionalNonNegativeNumber(value.completionTokens),
    promptCacheHitTokens: normalizeOptionalNonNegativeNumber(value.promptCacheHitTokens),
    promptCacheMissTokens: normalizeOptionalNonNegativeNumber(value.promptCacheMissTokens),
    promptTokens: normalizeOptionalNonNegativeNumber(value.promptTokens),
    reasoningTokens: normalizeOptionalNonNegativeNumber(value.reasoningTokens),
    totalTokens: normalizeOptionalNonNegativeNumber(value.totalTokens),
  };

  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function normalizeFreeTranslationHistoryPolicy(
  input: Partial<FreeTranslationHistoryPolicy>,
): FreeTranslationHistoryPolicy {
  return {
    maxCharacters: normalizePositiveInteger(
      input.maxCharacters,
      DEFAULT_FREE_TRANSLATION_HISTORY_POLICY.maxCharacters,
      Number.MAX_SAFE_INTEGER,
    ),
    maxEntries: normalizePositiveInteger(
      input.maxEntries,
      DEFAULT_FREE_TRANSLATION_HISTORY_POLICY.maxEntries,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function compareFreeTranslationRecordsNewestFirst(
  left: FreeTranslationRecord,
  right: FreeTranslationRecord,
) {
  return right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    right.id.localeCompare(left.id);
}

function createFreeTranslationRecordId(createdAt: number) {
  const randomId = globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2, 12);

  return `free-translation-${createdAt}-${randomId}`;
}

function requireNonEmptyString(value: unknown, fieldName: string) {
  const normalized = typeof value === "string" ? value.trim() : "";

  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function requireTextContent(value: unknown, fieldName: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${fieldName} is required.`);
  }

  return value;
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeOptionalString(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";

  return normalized || undefined;
}

function normalizeReasoningSummary(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";

  return normalized
    ? normalized.slice(0, FREE_TRANSLATION_REASONING_SUMMARY_MAX_CHARACTERS)
    : undefined;
}

function normalizeTimestamp(value: unknown, fallback = Date.now()) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function normalizeOptionalNonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
