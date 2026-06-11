import { getTranslationLanguagePromptLabel } from "./languages.mjs";

export const TRANSLATION_PROMPT_VERSION = "translation-v3";

const MAX_ABSTRACT_CHARS = 1800;
const MAX_CONTEXT_SECTION_CHARS = 6000;
const MAX_CONTEXT_SENTENCE_CHARS = 900;
const MAX_STYLE_CHARS = 1000;
const MAX_TARGET_SENTENCE_CHARS = 4000;
const MAX_TERM_CHARS = 120;
const MAX_TERM_COUNT = 80;
const MAX_TITLE_CHARS = 300;
const MAX_USER_PROMPT_CHARS = 18000;
const PROMPT_FIXED_OVERHEAD_CHARS = 1200;
const STABLE_CONTEXT_MIN_BUDGET_CHARS = 2600;

export function buildTranslationMessages(requestBody) {
  const paperContext = requestBody.longContextEnabled ? requestBody.paperContext : undefined;
  const sourceLanguage = getTranslationLanguagePromptLabel(requestBody.sourceLang);
  const targetLanguage = getTranslationLanguagePromptLabel(requestBody.targetLang);
  const promptContent = createBudgetedPromptContent(requestBody, paperContext);

  return [
    {
      role: "system",
      content: [
        "You are a professional academic translator.",
        `Translate ${sourceLanguage} academic writing into ${targetLanguage} with literal, precise wording.`,
        `Only translate the target sentence into ${targetLanguage}.`,
        "Use the requested target-language conventions consistently, including Simplified or Traditional Chinese script when applicable.",
        "Preserve formulas, citations, variables, method names, dataset names, and technical abbreviations.",
        "Preserve LaTeX math delimited by \\( \\), \\[ \\], or $$ $$ exactly, including equation tags.",
        "Follow this priority order: preserve formulas, citations, and terminology first; then apply custom style requirements; then apply preset style; then use general academic translation rules.",
        "Do not add commentary, explanation, markdown, or quotation marks.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "[Stable paper context]",
        `Title: ${promptContent.title}`,
        `Abstract: ${promptContent.abstract}`,
        "Terminology:",
        ...promptContent.terminology,
        "",
        "[Translation policy]",
        `Source language: ${sourceLanguage}`,
        `Target language: ${targetLanguage}`,
        `Style: ${promptContent.translationStyle}`,
        "Output only the translation.",
        "",
        "[Dynamic local context]",
        "Previous sentences:",
        ...promptContent.localContextBefore,
        "",
        "Target sentence:",
        promptContent.targetSentence,
        "",
        "Following sentences:",
        ...promptContent.localContextAfter,
      ].join("\n"),
    },
  ];
}

function createBudgetedPromptContent(requestBody, paperContext) {
  const targetSentence = truncateText(requestBody.targetSentence, MAX_TARGET_SENTENCE_CHARS);
  const translationStyle = truncateText(
    getTranslationStyleInstruction(requestBody.translationStyle),
    MAX_STYLE_CHARS,
  );
  let remainingBudget = Math.max(
    0,
    MAX_USER_PROMPT_CHARS - PROMPT_FIXED_OVERHEAD_CHARS - targetSentence.length - translationStyle.length,
  );
  const contextBudget = Math.min(
    MAX_CONTEXT_SECTION_CHARS,
    Math.max(0, remainingBudget - STABLE_CONTEXT_MIN_BUDGET_CHARS),
  );
  const contextBeforeBudget = Math.ceil(contextBudget / 2);
  const beforeResult = formatSentenceList(requestBody.localContextBefore, contextBeforeBudget);
  const afterResult = formatSentenceList(
    requestBody.localContextAfter,
    Math.max(0, contextBudget - beforeResult.usedCharacters),
  );

  remainingBudget = Math.max(
    0,
    remainingBudget - beforeResult.usedCharacters - afterResult.usedCharacters,
  );

  const title = truncateText(paperContext?.title ?? "", Math.min(MAX_TITLE_CHARS, remainingBudget));
  remainingBudget = Math.max(0, remainingBudget - title.length);

  const abstract = truncateText(
    paperContext?.abstract ?? "",
    Math.min(MAX_ABSTRACT_CHARS, remainingBudget),
  );
  remainingBudget = Math.max(0, remainingBudget - abstract.length);

  const terminology = Array.isArray(requestBody.terminologyOverride)
    ? requestBody.terminologyOverride
    : paperContext?.terminology;
  const terminologyResult = formatTerminology(terminology, remainingBudget);

  return {
    abstract,
    localContextAfter: afterResult.lines,
    localContextBefore: beforeResult.lines,
    targetSentence,
    terminology: terminologyResult.lines,
    title,
    translationStyle,
  };
}

function getTranslationStyleInstruction(translationStyle) {
  const presetId = normalizeTranslationStylePresetId(translationStyle?.presetId);

  if (presetId === "custom") {
    const customInstruction = truncateText(translationStyle?.customInstruction ?? "", 800);

    return customInstruction ||
      TRANSLATION_STYLE_PRESET_INSTRUCTIONS["academic-faithful"];
  }

  return TRANSLATION_STYLE_PRESET_INSTRUCTIONS[presetId] ??
    TRANSLATION_STYLE_PRESET_INSTRUCTIONS["academic-faithful"];
}

const TRANSLATION_STYLE_PRESET_INSTRUCTIONS = {
  "academic-faithful":
    "Use a faithful academic style: prioritize technical accuracy, literal correspondence, and stable terminology while keeping the target language grammatical.",
  "academic-fluent":
    "Use a fluent academic style: keep technical meaning exact, but smooth sentence flow and improve readability in the target language.",
  "concise-literal":
    "Use a concise literal style: stay close to the source wording, avoid embellishment, and remove only unnecessary verbosity.",
  "publication-polished":
    "Use a polished publication style: preserve meaning and terminology while making the target text sound suitable for a formal academic paper.",
  "reader-friendly":
    "Use a reader-friendly style: preserve technical precision while making complex phrasing easier to follow for a broad academic reader.",
};

function normalizeTranslationStylePresetId(value) {
  return Object.hasOwn(TRANSLATION_STYLE_PRESET_INSTRUCTIONS, value) || value === "custom"
    ? value
    : "academic-faithful";
}

function formatSentenceList(sentences, budget) {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return { lines: ["(none)"], usedCharacters: 6 };
  }

  return formatBudgetedLines(
    sentences.map((sentence) => `- ${truncateText(sentence, MAX_CONTEXT_SENTENCE_CHARS)}`),
    budget,
  );
}

function formatTerminology(terminology, budget) {
  if (!Array.isArray(terminology) || terminology.length === 0) {
    return { lines: ["(none)"], usedCharacters: 6 };
  }

  const lines = terminology
    .slice()
    .sort((left, right) => String(left.source).localeCompare(String(right.source)))
    .slice(0, MAX_TERM_COUNT)
    .map(
      (item) =>
        `- ${truncateText(item.source, MAX_TERM_CHARS)} => ${truncateText(item.target, MAX_TERM_CHARS)}`,
    );

  return formatBudgetedLines(lines, budget);
}

function formatBudgetedLines(lines, budget) {
  if (budget <= 0) {
    return {
      lines: ["(omitted due to prompt budget)"],
      usedCharacters: 30,
    };
  }

  const keptLines = [];
  let usedCharacters = 0;

  for (const line of lines) {
    const nextUsedCharacters = usedCharacters + line.length + 1;

    if (nextUsedCharacters > budget) {
      break;
    }

    keptLines.push(line);
    usedCharacters = nextUsedCharacters;
  }

  if (keptLines.length === 0) {
    return {
      lines: ["(omitted due to prompt budget)"],
      usedCharacters: 30,
    };
  }

  return {
    lines: keptLines,
    usedCharacters,
  };
}

function truncateText(value, maxCharacters) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();

  if (maxCharacters <= 0) {
    return "";
  }

  if (normalized.length <= maxCharacters) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}
