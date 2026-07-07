import { QA_PROMPT_VERSION } from "./config.mjs";

// Fallback caps used when no token-aware budget is supplied by the caller.
// These mirror the pre-1M behavior and keep the function safe to call on its own.
const DEFAULT_MAX_EVIDENCE_CHARS = 1800;
const DEFAULT_MAX_EVIDENCE_PACK_CHARS = 16000;
const DEFAULT_MAX_CONVERSATION_CONTEXT_CHARS = 5000;
const DEFAULT_MAX_CONTEXT_MESSAGE_CHARS = 900;
const DEFAULT_MAX_QUESTION_CHARS = 2000;

function resolveLimits(budget) {
  if (!budget) {
    return {
      maxEvidenceChars: DEFAULT_MAX_EVIDENCE_CHARS,
      maxEvidencePackChars: DEFAULT_MAX_EVIDENCE_PACK_CHARS,
      maxConversationContextChars: DEFAULT_MAX_CONVERSATION_CONTEXT_CHARS,
      maxContextMessageChars: DEFAULT_MAX_CONTEXT_MESSAGE_CHARS,
      maxQuestionChars: DEFAULT_MAX_QUESTION_CHARS,
    };
  }

  return {
    maxEvidenceChars: budget.perEvidenceChars || DEFAULT_MAX_EVIDENCE_CHARS,
    maxEvidencePackChars: budget.evidencePackChars || DEFAULT_MAX_EVIDENCE_PACK_CHARS,
    maxConversationContextChars:
      budget.conversationContextChars || DEFAULT_MAX_CONVERSATION_CONTEXT_CHARS,
    maxContextMessageChars: budget.perMessageChars || DEFAULT_MAX_CONTEXT_MESSAGE_CHARS,
    maxQuestionChars: budget.questionChars || DEFAULT_MAX_QUESTION_CHARS,
  };
}

export function buildQaAnswerMessages({
  answerLanguage = "auto",
  budget,
  chatContext,
  directReplyOutline,
  evidence,
  fullPaperText,
  paperTitle,
  mode = "answer",
  question,
}) {
  const limits = resolveLimits(budget);
  const conversationContext = formatConversationContext(chatContext, limits);

  if (mode === "direct") {
    return [
      {
        role: "system",
        content: [
          "You are a friendly academic paper reading assistant embedded in a PDF reader.",
          "The retrieval controller decided this message does not require evidence from the current paper.",
          "Respond naturally and concisely. Do not invent paper details and do not use [Cn] citations.",
          "Keep it short and helpful. You may briefly remind the user they can ask about the paper's content.",
          "When the user writes in Chinese, reply in Chinese; when in English, reply in English.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "[Answer language]",
          normalizeAnswerLanguage(answerLanguage),
          ...(conversationContext
            ? ["", "[Conversation context]", conversationContext]
            : []),
          ...(directReplyOutline ? ["", "[Reply outline]", directReplyOutline] : []),
          "",
          "[User message]",
          truncateText(question, limits.maxQuestionChars),
        ].join("\n"),
      },
    ];
  }

  if (mode === "long_context") {
    return [
      {
        role: "system",
        content: [
          "You are a careful academic paper QA assistant.",
          "The user is asking a whole-paper question (summary, contribution, methodology outline, etc.).",
          "The full paper text is provided below in MathPix LaTeX (MMD) format, which preserves formulas and structure.",
          "Answer based on the full paper. You do not need to cite [Cn] evidence ids (none are provided).",
          "When you reference a specific part, name the section (e.g. 'see Methods', 'in Section 3').",
          "If the full text is truncated, work with what is provided and note if a part is missing.",
          "Structure the answer with headings or bullet points for readability.",
          "When the user asks in Chinese, answer in Chinese unless they explicitly request another language.",
          "When the user asks in English, answer in English unless they explicitly request another language.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "[Answer language]",
          normalizeAnswerLanguage(answerLanguage),
          ...(conversationContext
            ? ["", "[Conversation context]", conversationContext]
            : []),
          ...(paperTitle ? ["", "[Paper title]", paperTitle] : []),
          "",
          "[Full paper (MathPix)]",
          fullPaperText ?? "(full paper text unavailable)",
          "",
          "[Question]",
          truncateText(question, limits.maxQuestionChars),
        ].join("\n"),
      },
    ];
  }

  return [
    {
      role: "system",
      content: [
        "You are a careful academic paper QA assistant.",
        "Answer only from the provided evidence pack.",
        "Conversation context may help resolve follow-up references, but it is not paper evidence.",
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
        ...(conversationContext
          ? [
              "[Conversation context]",
              conversationContext,
              "",
            ]
          : []),
        "[Question]",
        truncateText(question, limits.maxQuestionChars),
        "",
        "[Evidence pack]",
        formatEvidencePack(evidence, limits),
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
      mmd: item.mmd,
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

function formatEvidencePack(evidence, limits) {
  const maxEvidenceChars = limits?.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS;
  const maxEvidencePackChars = limits?.maxEvidencePackChars ?? DEFAULT_MAX_EVIDENCE_PACK_CHARS;
  let usedCharacters = 0;
  const blocks = [];

  for (const item of evidence) {
    const text = truncateText(item.text ?? item.textPreview ?? "", maxEvidenceChars);
    const mmd = item.mmd ? truncateText(item.mmd, maxEvidenceChars) : "";
    const block = [
      `[${item.evidenceId}]`,
      `Document: ${item.documentTitle || "Current paper"}`,
      `Pages: ${formatPageRange(item.pageStart, item.pageEnd)}`,
      `Section: ${formatSectionPath(item.sectionPath)}`,
      "Text:",
      text,
      ...(mmd ? ["", "LaTeX:", mmd] : []),
    ].join("\n");

    if (usedCharacters + block.length > maxEvidencePackChars && blocks.length > 0) {
      break;
    }

    blocks.push(block);
    usedCharacters += block.length + 2;
  }

  return blocks.length > 0 ? blocks.join("\n\n") : "(no evidence retrieved)";
}

function formatConversationContext(chatContext, limits) {
  if (!chatContext || typeof chatContext !== "object") {
    return "";
  }

  const maxContextMessageChars = limits?.maxContextMessageChars ?? DEFAULT_MAX_CONTEXT_MESSAGE_CHARS;
  const maxConversationContextChars =
    limits?.maxConversationContextChars ?? DEFAULT_MAX_CONVERSATION_CONTEXT_CHARS;
  const lines = [
    "Use this only to understand the user's follow-up. Do not treat it as paper evidence.",
  ];
  const recentMessages = Array.isArray(chatContext.recentMessages)
    ? chatContext.recentMessages
    : [];

  if (chatContext.userIntent) {
    lines.push(`User intent: ${chatContext.userIntent}.`);
  }

  if (recentMessages.length > 0) {
    lines.push("Recent messages:");

    for (const message of recentMessages) {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = stripPriorCitationIds(truncateText(message?.content ?? "", maxContextMessageChars));

      if (content) {
        lines.push(`- ${role}: ${content}`);
      }
    }
  }

  return truncateText(lines.join("\n"), maxConversationContextChars);
}

function stripPriorCitationIds(text) {
  return String(text ?? "").replace(/\[C\d+\]/g, "[prior citation]");
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
