import { QA_PROMPT_VERSION } from "./config.mjs";

const MAX_EVIDENCE_CHARS = 1800;
const MAX_EVIDENCE_PACK_CHARS = 16000;
const MAX_QUESTION_CHARS = 2000;

export function buildQaAnswerMessages({
  answerLanguage = "auto",
  evidence,
  question,
}) {
  return [
    {
      role: "system",
      content: [
        "You are a careful academic paper QA assistant.",
        "Answer only from the provided evidence pack.",
        "Every factual claim that depends on the paper must cite one or more evidence ids like [C1].",
        "Do not cite papers, pages, chunks, or evidence ids that are not present in the evidence pack.",
        "If the evidence is insufficient, say what is missing instead of guessing.",
        "Do not mention hidden reasoning or chain-of-thought.",
        "Keep the answer concise, but include enough detail to be useful.",
        "When the user asks in Chinese, answer in Chinese unless they explicitly request another language.",
        "When the user asks in English, answer in English unless they explicitly request another language.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "[Answer language]",
        normalizeAnswerLanguage(answerLanguage),
        "",
        "[Question]",
        truncateText(question, MAX_QUESTION_CHARS),
        "",
        "[Evidence pack]",
        formatEvidencePack(evidence),
        "",
        "[Required output]",
        "Answer the question using inline citations such as [C1].",
        "Do not include a separate bibliography unless it helps readability.",
      ].join("\n"),
    },
  ];
}

export function createRetrievalSnapshot({
  activeDocumentId,
  evidence,
  queryPlan,
  rerankerVersion,
  retrieverVersion,
}) {
  return {
    activeCloudDocumentId: activeDocumentId,
    evidence: evidence.map((item) => ({
      chunkId: item.chunkId,
      cloudDocumentId: item.cloudDocumentId,
      documentTitle: item.documentTitle,
      evidenceId: item.evidenceId,
      pageEnd: item.pageEnd,
      pageStart: item.pageStart,
      pdfFingerprint: item.pdfFingerprint,
      score: item.score,
      scoreBreakdown: item.scoreBreakdown,
      sectionPath: item.sectionPath,
      textPreview: item.textPreview,
    })),
    queryPlan,
    referenceDocumentIds: [],
    rerankerVersion,
    retrieverVersion,
    scope: "current",
  };
}

export { QA_PROMPT_VERSION };

function formatEvidencePack(evidence) {
  let usedCharacters = 0;
  const blocks = [];

  for (const item of evidence) {
    const text = truncateText(item.text ?? item.textPreview ?? "", MAX_EVIDENCE_CHARS);
    const block = [
      `[${item.evidenceId}]`,
      `Document: ${item.documentTitle || "Current paper"}`,
      `Pages: ${formatPageRange(item.pageStart, item.pageEnd)}`,
      `Section: ${formatSectionPath(item.sectionPath)}`,
      "Text:",
      text,
    ].join("\n");

    if (usedCharacters + block.length > MAX_EVIDENCE_PACK_CHARS && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    usedCharacters += block.length + 2;
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "(no evidence retrieved)";
}

function normalizeAnswerLanguage(value) {
  if (value === "zh") {
    return "Chinese";
  }

  if (value === "en") {
    return "English";
  }

  return "Follow the user's question language.";
}

function formatPageRange(pageStart, pageEnd) {
  if (pageStart === pageEnd) {
    return `p.${pageStart}`;
  }

  return `pp.${pageStart}-${pageEnd}`;
}

function formatSectionPath(sectionPath) {
  return Array.isArray(sectionPath) && sectionPath.length > 0
    ? sectionPath.join(" / ")
    : "(unknown)";
}

function truncateText(value, maxCharacters) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trim()}...`;
}
