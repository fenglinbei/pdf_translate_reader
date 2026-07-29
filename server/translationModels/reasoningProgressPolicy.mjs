export const REASONING_PROGRESS_PHASES = new Set([
  "comprehension",
  "disambiguation",
  "terminology",
  "references",
  "structure",
  "style",
  "formatting",
  "verification",
  "finalization",
  "other",
]);

export const REASONING_PROGRESS_CHANGES = new Set([
  "major",
  "material",
  "same",
]);

const EFFORT_CONFIGS = {
  low: {
    attemptLimit: 12,
    boundaryMinimumUnits: 3,
    cadence: [3, 3, 4, 4, 5, 5],
    hardPartLimit: 8,
    maxQueuedCandidates: 2,
    maxRetainedRawCharacters: 32_000,
    softPartLimit: 6,
    timeoutMs: 3_000,
  },
  high: {
    attemptLimit: 24,
    boundaryMinimumUnits: 2,
    cadence: [2, 2, 3, 3, 4, 4],
    hardPartLimit: 16,
    maxQueuedCandidates: 3,
    maxRetainedRawCharacters: 64_000,
    softPartLimit: 10,
    timeoutMs: 4_000,
  },
  max: {
    attemptLimit: 36,
    boundaryMinimumUnits: 1,
    cadence: [1, 1, 2, 2, 3, 3],
    hardPartLimit: 24,
    maxQueuedCandidates: 4,
    maxRetainedRawCharacters: 96_000,
    softPartLimit: 16,
    timeoutMs: 5_000,
  },
};

export function getReasoningProgressEffortConfig(effort) {
  return {
    ...(EFFORT_CONFIGS[effort] ?? EFFORT_CONFIGS.high),
  };
}

export function createAdaptiveReasoningProgressPolicy({ effort } = {}) {
  const config = getReasoningProgressEffortConfig(effort);
  let cadenceIndex = 0;
  let lastPublishedPhase;
  let lastObservedPhase;
  let unitsSinceCandidate = 0;

  function observe(unit) {
    const phaseHint = inferReasoningPhase(unit.text);
    const phaseChanged = phaseHint !== "other" &&
      lastObservedPhase !== undefined &&
      phaseHint !== lastObservedPhase;

    if (phaseHint !== "other") {
      lastObservedPhase = phaseHint;
    }

    unitsSinceCandidate += 1;
    const cadence = config.cadence[
      Math.min(cadenceIndex, config.cadence.length - 1)
    ];
    const strongBoundary =
      unit.boundary === "paragraph" ||
      unit.boundary === "step" ||
      unit.transition;
    const shouldCreateCandidate =
      phaseChanged ||
      strongBoundary && unitsSinceCandidate >= config.boundaryMinimumUnits ||
      unitsSinceCandidate >= cadence;

    if (!shouldCreateCandidate) {
      return {
        phaseChanged,
        phaseHint,
        shouldCreateCandidate: false,
      };
    }

    if (phaseChanged) {
      cadenceIndex = 0;
    } else {
      cadenceIndex = Math.min(
        cadenceIndex + 1,
        config.cadence.length - 1,
      );
    }
    unitsSinceCandidate = 0;

    return {
      phaseChanged,
      phaseHint,
      reason: phaseChanged
        ? "phase-change"
        : strongBoundary
          ? "semantic-boundary"
          : "adaptive-cadence",
      shouldCreateCandidate: true,
    };
  }

  function assessPublicUpdate({ change, partCount, phase }) {
    const normalizedPhase = REASONING_PROGRESS_PHASES.has(phase)
      ? phase
      : "other";
    const normalizedChange = REASONING_PROGRESS_CHANGES.has(change)
      ? change
      : "same";
    const phaseChanged = normalizedPhase !== "other" &&
      lastPublishedPhase !== undefined &&
      normalizedPhase !== lastPublishedPhase;
    const firstMaterialUpdate =
      lastPublishedPhase === undefined &&
      normalizedChange !== "same";
    const effectiveChange = phaseChanged ? "major" : normalizedChange;
    const withinHardLimit = partCount < config.hardPartLimit;
    const withinSoftLimit = partCount < config.softPartLimit;
    const publish = withinHardLimit && (
      firstMaterialUpdate ||
      effectiveChange === "major" ||
      withinSoftLimit && effectiveChange === "material"
    );

    return {
      change: effectiveChange,
      phase: normalizedPhase,
      phaseChanged,
      publish,
    };
  }

  function recordPublishedPhase(phase) {
    if (REASONING_PROGRESS_PHASES.has(phase)) {
      lastPublishedPhase = phase;
    }
  }

  return {
    assessPublicUpdate,
    config,
    observe,
    recordPublishedPhase,
  };
}

export function inferReasoningPhase(value) {
  const text = String(value ?? "").toLocaleLowerCase();

  if (/(?:markdown|latex|mathjax|公式|表格|代码|格式|排版|标记)/iu.test(text)) {
    return "formatting";
  }

  if (/(?:coreference|reference|pronoun|citation|指代|代词|引用|前文|后文)/iu.test(text)) {
    return "references";
  }

  if (/(?:terminolog|glossar|proper noun|术语|专名|名词|命名)/iu.test(text)) {
    return "terminology";
  }

  if (/(?:ambigu|context|word sense|歧义|语境|上下文|多义)/iu.test(text)) {
    return "disambiguation";
  }

  if (/(?:syntax|sentence|paragraph|clause|structure|句法|句子|段落|从句|结构)/iu.test(text)) {
    return "structure";
  }

  if (/(?:tone|register|style|voice|语气|语域|文风|风格|措辞)/iu.test(text)) {
    return "style";
  }

  if (/(?:verify|check|review|consistent|complete|核对|检查|验证|一致|完整|复核)/iu.test(text)) {
    return "verification";
  }

  if (/(?:final|polish|finish|最后|最终|收尾|定稿|润色)/iu.test(text)) {
    return "finalization";
  }

  if (/(?:meaning|intent|understand|semantic|含义|意图|理解|语义|主旨)/iu.test(text)) {
    return "comprehension";
  }

  return "other";
}
