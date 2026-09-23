import { QA_AGENT_RUNNER_VERSION } from "../config.mjs";
import { uniqueStrings } from "./values.mjs";

export function normalizeEvidenceIds(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueStrings(values.map((value) => String(value ?? "").trim()));
}

export function selectFinalEvidence(evidence, evidenceIds) {
  const selectedIds = normalizeEvidenceIds(evidenceIds);

  if (selectedIds.length === 0) {
    return evidence;
  }

  const selectedEvidence = selectedIds
    .map((evidenceId) => evidence.find((item) => item.evidenceId === evidenceId))
    .filter(Boolean);

  return selectedEvidence.length > 0 ? selectedEvidence : evidence;
}

export function mergeEvidence(currentEvidence, nextEvidence, maxEvidence) {
  const evidenceByChunkId = new Map();

  for (const item of [...currentEvidence, ...nextEvidence]) {
    const existing = evidenceByChunkId.get(item.chunkId);

    if (!existing || Number(item.score) > Number(existing.score)) {
      evidenceByChunkId.set(item.chunkId, item);
    }
  }

  const deduped = dedupeOverlappingEvidence(Array.from(evidenceByChunkId.values()));

  return deduped
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, maxEvidence)
    .map((item, index) => ({
      ...item,
      evidenceId: `C${index + 1}`,
    }));
}

// The chunker produces overlapping chunks (default 400-token overlap), so two
// different chunks can share most of their text. Drop the lower-scoring one
// when their text overlap is high, keeping the result list diverse.
function dedupeOverlappingEvidence(items) {
  const sorted = [...items].sort((left, right) => Number(right.score) - Number(left.score));
  const kept = [];

  for (const candidate of sorted) {
    const candidateFingerprint = textFingerprint(candidate.textPreview);
    const isDuplicate = kept.some((existing) => {
      const existingFingerprint = textFingerprint(existing.textPreview);
      return textOverlapRatio(candidateFingerprint, existingFingerprint) >= 0.75;
    });

    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

// Build a set of normalized word tokens for cheap overlap comparison.
// Keep alphanumerics together (e.g. "chunk-1" → "chunk1") so distinct
// identifiers remain distinguishable.
function textFingerprint(value) {
  const tokens = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/gi, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1);

  return new Set(tokens);
}

// Jaccard-like ratio of shared tokens between two fingerprints.
// Requires a minimum token count so short snippets (e.g. headings) are not
// falsely flagged as duplicates of each other.
function textOverlapRatio(left, right) {
  if (left.size < 8 || right.size < 8) {
    return 0;
  }

  let shared = 0;
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  for (const token of smaller) {
    if (larger.has(token)) {
      shared += 1;
    }
  }

  return shared / Math.min(left.size, right.size);
}

export function getTopPages(evidence) {
  return Array.from(new Set(
    evidence
      .slice(0, 5)
      .map((item) => `p.${item.pageStart}`)
      .filter(Boolean),
  ));
}

export function createEmptyRetrieval(queryPlan) {
  return {
    diagnostics: {
      agent: {
        runnerVersion: QA_AGENT_RUNNER_VERSION,
      },
      candidateCount: 0,
    },
    evidence: [],
    queryPlan,
    retrieverVersion: "none",
    warnings: [],
  };
}
