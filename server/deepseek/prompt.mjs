export const TRANSLATION_PROMPT_VERSION = "translation-v1";

const MAX_ABSTRACT_CHARS = 1800;
const MAX_CONTEXT_SENTENCE_CHARS = 900;
const MAX_TARGET_SENTENCE_CHARS = 4000;
const MAX_TERM_CHARS = 120;
const MAX_TERM_COUNT = 80;
const MAX_TITLE_CHARS = 300;

export function buildTranslationMessages(requestBody) {
  const paperContext = requestBody.longContextEnabled ? requestBody.paperContext : undefined;

  return [
    {
      role: "system",
      content: [
        "You are a professional academic translator.",
        "Translate English academic writing into Simplified Chinese with literal, precise wording.",
        "Only translate the target sentence into Simplified Chinese.",
        "Preserve formulas, citations, variables, method names, dataset names, and technical abbreviations.",
        "Do not add commentary, explanation, markdown, or quotation marks.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "[Stable paper context]",
        `Title: ${truncateText(paperContext?.title ?? "", MAX_TITLE_CHARS)}`,
        `Abstract: ${truncateText(paperContext?.abstract ?? "", MAX_ABSTRACT_CHARS)}`,
        "Terminology:",
        ...formatTerminology(paperContext?.terminology),
        "",
        "[Translation policy]",
        "Source language: English",
        "Target language: Simplified Chinese",
        "Output only the translation.",
        "",
        "[Dynamic local context]",
        "Previous sentences:",
        ...formatSentenceList(requestBody.localContextBefore),
        "",
        "Target sentence:",
        truncateText(requestBody.targetSentence, MAX_TARGET_SENTENCE_CHARS),
        "",
        "Following sentences:",
        ...formatSentenceList(requestBody.localContextAfter),
      ].join("\n"),
    },
  ];
}

function formatSentenceList(sentences) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return ["(none)"];
  }

  return sentences.map((sentence) => `- ${truncateText(sentence, MAX_CONTEXT_SENTENCE_CHARS)}`);
}

function formatTerminology(terminology) {
  if (!Array.isArray(terminology) || terminology.length === 0) {
    return ["(none)"];
  }

  return terminology
    .slice()
    .sort((left, right) => String(left.source).localeCompare(String(right.source)))
    .slice(0, MAX_TERM_COUNT)
    .map((item) => `- ${truncateText(item.source, MAX_TERM_CHARS)} => ${truncateText(item.target, MAX_TERM_CHARS)}`);
}

function truncateText(value, maxCharacters) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();

  if (normalized.length <= maxCharacters) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}
