export const TRANSLATION_PROMPT_VERSION = "translation-v1";

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
        `Title: ${paperContext?.title ?? ""}`,
        `Abstract: ${paperContext?.abstract ?? ""}`,
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
        requestBody.targetSentence,
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

  return sentences.map((sentence) => `- ${sentence}`);
}

function formatTerminology(terminology) {
  if (!Array.isArray(terminology) || terminology.length === 0) {
    return ["(none)"];
  }

  return terminology
    .slice()
    .sort((left, right) => String(left.source).localeCompare(String(right.source)))
    .map((item) => `- ${item.source} => ${item.target}`);
}
