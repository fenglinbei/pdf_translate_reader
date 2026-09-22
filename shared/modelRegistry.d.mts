import type catalog from "./modelCatalog.json";

export type ModelId = keyof typeof catalog.models;
export type ModelTask = "translation" | "qa";
export type ModelTier = "core" | "optional" | "legacy";
export type ModelProvider = "deepseek" | "qwen" | "glm" | "kimi";
export type ReasoningEffort = "low" | "high" | "max";
export type ThinkingConfig = { enabled: boolean; effort?: string };
export type TranslationReasoningCapability = {
  readonly canDisable: boolean;
  readonly defaultEnabled: boolean;
  readonly defaultEffort: ReasoningEffort;
  readonly efforts: readonly ReasoningEffort[];
};
export type ModelDefinition = {
  readonly label: string;
  readonly shortLabel: string;
  readonly provider: ModelProvider;
  readonly apiModel: string;
  readonly tier: ModelTier;
  readonly replacement?: ModelId;
  readonly availability: Readonly<Partial<Record<ModelTask, "ready" | "pending" | "history">>>;
  readonly context: {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly defaultMaxTokens: number;
  };
  readonly outputTokenParameter: "max_tokens" | "max_completion_tokens";
  readonly reasoningProfile: string;
  readonly reasoning: {
    readonly toggleParameter: "thinking" | "enable_thinking" | null;
    readonly providerEfforts: readonly string[];
    readonly translation: TranslationReasoningCapability;
    readonly translationEffortMap: Readonly<Record<ReasoningEffort, string>>;
    readonly qa: Readonly<Record<"quick" | "standard" | "deep", ThinkingConfig>>;
  };
  readonly source: string;
};
export const MODEL_CATALOG: Readonly<Record<ModelId, ModelDefinition>>;
export const MODEL_DEFAULTS: Readonly<Record<"translation" | "qa" | "reasoningSummary", ModelId>>;
export const MODEL_CATALOG_VERSION: string;
export const MODEL_IDS: readonly ModelId[];
export const TRANSLATION_REASONING_EFFORTS: readonly ReasoningEffort[];
export function getModelDefinition(id: unknown): ModelDefinition | undefined;
export function requireModelDefinition(id: unknown): ModelDefinition;
export function isKnownModel(id: unknown, task?: ModelTask): id is ModelId;
export function getModelIds(options?: {task?: ModelTask; tier?: ModelTier; readyOnly?: boolean}): ModelId[];
export function getAvailableModelIds(task: ModelTask): ModelId[];
export function isAvailableModel(id: unknown, task: ModelTask): id is ModelId;
export function getModelLabel(id: unknown): string;
export function getTranslationReasoningCapability(id: ModelId): TranslationReasoningCapability;
export function resolveTranslationReasoning(id: ModelId, reasoning?: {enabled?: unknown; effort?: unknown}): {
  effort: ReasoningEffort;
  enabled: boolean;
  forced: boolean;
  requestedEnabled: boolean;
};
export function resolveQaThinking(id: ModelId, effort?: string): ThinkingConfig;
export function createModelCounts(): Record<ModelId, number>;
