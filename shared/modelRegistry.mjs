import catalog from "./modelCatalog.json" with { type: "json" };

// This module is shared by Vite and Node. Keep credentials and runtime env
// access in server/models; the catalog contains public model metadata only.
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const MODEL_CATALOG = deepFreeze(Object.fromEntries(
  Object.entries(catalog.models).map(([id, model]) => [
    id,
    { ...model, reasoning: catalog.reasoningProfiles[model.reasoningProfile] },
  ]),
));
export const MODEL_DEFAULTS = deepFreeze(catalog.defaults);
export const MODEL_CATALOG_VERSION = catalog.version;
export const MODEL_IDS = Object.freeze(Object.keys(MODEL_CATALOG));
export const TRANSLATION_REASONING_EFFORTS = Object.freeze(["low", "high", "max"]);

export function getModelDefinition(id) {
  return typeof id === "string" && Object.hasOwn(MODEL_CATALOG, id)
    ? MODEL_CATALOG[id]
    : undefined;
}

export function requireModelDefinition(id) {
  const model = getModelDefinition(id);
  if (!model) throw new Error(`Unknown model: ${String(id)}`);
  return model;
}

// Registered models can appear in saved history before/after they are
// selectable. Reading a record must never silently rename its model.
export function isKnownModel(id, task) {
  const model = getModelDefinition(id);
  return Boolean(model && (!task || Object.hasOwn(model.availability, task)));
}

export function getModelIds({ task, tier, readyOnly = false } = {}) {
  return MODEL_IDS.filter((id) => {
    const model = MODEL_CATALOG[id];
    return (!tier || model.tier === tier) &&
      (!task || Object.hasOwn(model.availability, task)) &&
      (!readyOnly || (task && model.availability[task] === "ready"));
  });
}

export function getAvailableModelIds(task) {
  return getModelIds({ task, readyOnly: true });
}

export function isAvailableModel(id, task) {
  return getModelDefinition(id)?.availability[task] === "ready";
}

export function getModelLabel(id) {
  return getModelDefinition(id)?.label ?? (typeof id === "string" ? id : "-");
}

export function getTranslationReasoningCapability(id) {
  return requireModelDefinition(id).reasoning.translation;
}

export function resolveTranslationReasoning(id, reasoning = {}) {
  const capability = getTranslationReasoningCapability(id);
  const requestedEnabled = typeof reasoning.enabled === "boolean"
    ? reasoning.enabled
    : capability.defaultEnabled;
  const enabled = capability.canDisable ? requestedEnabled : true;
  const effort = capability.efforts.includes(reasoning.effort)
    ? reasoning.effort
    : capability.defaultEffort;
  return { effort, enabled, forced: enabled !== requestedEnabled, requestedEnabled };
}

export function resolveQaThinking(id, effort = "standard") {
  const modes = requireModelDefinition(id).reasoning.qa;
  return { ...(Object.hasOwn(modes, effort) ? modes[effort] : modes.standard) };
}

export function createModelCounts() {
  return Object.fromEntries(MODEL_IDS.map((id) => [id, 0]));
}
