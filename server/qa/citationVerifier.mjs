const CITATION_PATTERN = /\[C(\d+)\]/g;
const MAX_QUOTED_TEXT_CHARS = 700;

export function verifyAnswerCitations({ answerText, evidence }) {
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const citedEvidenceIds = extractCitationIds(answerText);
  const citations = [];
  const rejected = [];
  const warnings = [];

  for (const evidenceId of citedEvidenceIds) {
    const item = evidenceById.get(evidenceId);

    if (!item) {
      rejected.push({
        confidence: "rejected",
        evidenceId,
        reason: "citation_not_in_retrieval",
      });
      continue;
    }

    citations.push({
      chunkId: item.chunkId,
      cloudDocumentId: item.cloudDocumentId,
      confidence: "verified",
      documentTitle: item.documentTitle,
      evidenceId,
      pageEnd: item.pageEnd,
      pageStart: item.pageStart,
      pdfFingerprint: item.pdfFingerprint,
      quotedText: truncateQuotedText(item.text ?? item.textPreview ?? ""),
      sectionPath: item.sectionPath,
    });
  }

  if (evidence.length > 0 && citations.length === 0) {
    warnings.push("The answer did not cite any retrieved evidence.");
  }

  if (rejected.length > 0) {
    warnings.push("Some citations were rejected because they were not present in this retrieval.");
  }

  return {
    citations,
    rejected,
    warnings,
  };
}

export function extractCitationIds(answerText) {
  const ids = [];
  const seen = new Set();
  const text = String(answerText ?? "");

  for (const match of text.matchAll(CITATION_PATTERN)) {
    const id = `C${Number(match[1])}`;

    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

function truncateQuotedText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= MAX_QUOTED_TEXT_CHARS) {
    return text;
  }

  return `${text.slice(0, MAX_QUOTED_TEXT_CHARS - 3).trim()}...`;
}
