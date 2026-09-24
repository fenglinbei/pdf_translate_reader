import { truncateForController } from "./values.mjs";

export function normalizeCarryoverEvidence(values, maxEvidence) {
  const evidenceByChunkId = new Map();

  for (const item of Array.isArray(values) ? values : []) {
    if (!item || typeof item.chunkId !== "string" || evidenceByChunkId.has(item.chunkId)) {
      continue;
    }

    evidenceByChunkId.set(item.chunkId, {
      chunkId: item.chunkId,
      cloudDocumentId: item.cloudDocumentId,
      documentTitle: item.documentTitle,
      evidenceId: item.evidenceId,
      mmd: item.mmd,
      lineRegions: item.lineRegions,
      pageEnd: item.pageEnd,
      pageStart: item.pageStart,
      pdfFingerprint: item.pdfFingerprint,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : 0,
      scoreBreakdown: item.scoreBreakdown,
      sectionPath: Array.isArray(item.sectionPath) ? item.sectionPath : [],
      text: item.text,
      textPreview: item.textPreview ?? item.text ?? "",
    });
  }

  return Array.from(evidenceByChunkId.values())
    .sort((left, right) => Number(right.score) - Number(left.score))
    .slice(0, maxEvidence)
    .map((item, index) => ({
      ...item,
      evidenceId: `C${index + 1}`,
    }));
}

export function mapCarryoverEvidenceToCurrentIds(currentEvidence, carryoverEvidence) {
  if (!Array.isArray(currentEvidence) || !Array.isArray(carryoverEvidence) || carryoverEvidence.length === 0) {
    return [];
  }

  const carryoverChunkIds = new Set(carryoverEvidence.map((item) => item.chunkId));

  return currentEvidence.filter((item) => carryoverChunkIds.has(item.chunkId));
}

export function summarizeChatContextForStep(chatContext, carryoverEvidence) {
  if (!chatContext) {
    return undefined;
  }

  return {
    carryoverEvidenceIds: carryoverEvidence.map((item) => item.evidenceId),
    mentionedEvidenceIds: chatContext.mentionedEvidenceIds ?? [],
    recentMessageCount: chatContext.recentMessages?.length ?? 0,
    summary: chatContext.summary,
    userIntent: chatContext.userIntent,
  };
}

export function summarizeChatContextForController(chatContext, carryoverEvidence) {
  if (!chatContext) {
    return undefined;
  }

  return {
    carryoverEvidenceIds: carryoverEvidence.map((item) => item.evidenceId),
    instruction: [
      "Use the recent messages only to resolve follow-up references and decide whether prior evidence is still relevant.",
      "Paper facts must be supported by currentEvidence and final citations must use current evidence ids only.",
    ].join(" "),
    mentionedEvidenceIds: chatContext.mentionedEvidenceIds ?? [],
    recentMessages: (chatContext.recentMessages ?? []).map((message) => ({
      content: truncateForController(stripPriorCitationIds(message.content), 700),
      role: message.role,
    })),
    userIntent: chatContext.userIntent,
  };
}

function stripPriorCitationIds(text) {
  return String(text ?? "").replace(/\[C\d+\]/g, "[prior citation]");
}
