const MAX_LANGUAGE_SAMPLE_CHARACTERS = 12_000;

const LATIN_LANGUAGE_STOPWORDS = {
  de: new Set([
    "aber", "als", "auch", "auf", "aus", "bei", "das", "dem", "den", "der",
    "des", "die", "durch", "ein", "eine", "einer", "für", "ist", "mit",
    "nicht", "oder", "sich", "sind", "und", "von", "werden", "wie", "zu",
  ]),
  en: new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from",
    "has", "hello", "in", "is", "it", "of", "on", "or", "that", "the",
    "this", "to", "using", "was", "we", "which", "with", "world",
  ]),
  es: new Set([
    "al", "como", "con", "de", "del", "el", "en", "es", "esta", "este",
    "la", "las", "los", "más", "no", "para", "por", "que", "se", "son",
    "su", "una", "uno", "un", "y",
  ]),
  fr: new Set([
    "au", "aux", "avec", "ce", "ces", "comme", "dans", "de", "des", "du",
    "en", "est", "et", "la", "le", "les", "ne", "ou", "par", "pas", "pour",
    "que", "qui", "sur", "une", "un",
  ]),
};

const STRONG_LATIN_WORDS = {
  de: new Set(["bitte", "danke", "deutsch", "hallo", "nicht"]),
  en: new Set(["english", "hello", "thanks", "world"]),
  es: new Set(["español", "gracias", "hola", "usted"]),
  fr: new Set(["bonjour", "français", "merci", "vous"]),
};

const SIMPLIFIED_ONLY_CHARACTERS = new Set(
  "万与专业东个为书云产会体关兴写后发变叶号听国学实将层广应开归当总术汉测点现电画着礼离种称简线组经给统网联质转这进门间马验",
);
const TRADITIONAL_ONLY_CHARACTERS = new Set(
  "萬與專業東個為書雲產會體關興寫後發變葉號聽國學實將層廣應開歸當總術漢測點現電畫著禮離種稱簡線組經給統網聯質轉這進門間馬驗",
);

export function detectTranslationSourceLanguage(input) {
  const text = normalizeLanguageSample(input);

  if (!text) {
    return undefined;
  }

  const scriptResult = detectScriptLanguage(text);

  if (scriptResult) {
    return scriptResult;
  }

  return detectLatinLanguage(text);
}

function detectScriptLanguage(text) {
  const hangulCount = countMatches(text, /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/gu);
  const kanaCount = countMatches(text, /[\u3040-\u30ff\u31f0-\u31ff]/gu);
  const hanCharacters = text.match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu) ?? [];
  const latinCount = countMatches(text, /[A-Za-zÀ-ÖØ-öø-ÿŒœ]/gu);
  const scriptLetterCount = hangulCount + kanaCount + hanCharacters.length + latinCount;

  if (
    hangulCount >= 2 &&
    hangulCount / Math.max(1, scriptLetterCount) >= 0.08
  ) {
    return {
      confidence: 0.99,
      language: "ko",
      source: "local",
    };
  }

  if (
    kanaCount >= 1 &&
    kanaCount / Math.max(1, scriptLetterCount) >= 0.05
  ) {
    return {
      confidence: 0.99,
      language: "ja",
      source: "local",
    };
  }

  if (
    hanCharacters.length >= 2 &&
    hanCharacters.length >= latinCount * 0.5
  ) {
    let simplifiedSignals = 0;
    let traditionalSignals = 0;

    for (const character of hanCharacters) {
      if (SIMPLIFIED_ONLY_CHARACTERS.has(character)) {
        simplifiedSignals += 1;
      }
      if (TRADITIONAL_ONLY_CHARACTERS.has(character)) {
        traditionalSignals += 1;
      }
    }

    const variantSignals = simplifiedSignals + traditionalSignals;

    if (
      variantSignals < 2 ||
      simplifiedSignals === traditionalSignals
    ) {
      return undefined;
    }

    return {
      confidence: 0.94,
      language: traditionalSignals > simplifiedSignals ? "zh-Hant" : "zh",
      source: "local",
    };
  }

  return undefined;
}

function detectLatinLanguage(text) {
  const tokens = text
    .toLocaleLowerCase("und")
    .match(/[A-Za-zÀ-ÖØ-öø-ÿŒœß]+/gu) ?? [];

  if (tokens.length === 0) {
    return undefined;
  }

  const scores = {
    de: scoreTokens(tokens, LATIN_LANGUAGE_STOPWORDS.de),
    en: scoreTokens(tokens, LATIN_LANGUAGE_STOPWORDS.en),
    es: scoreTokens(tokens, LATIN_LANGUAGE_STOPWORDS.es),
    fr: scoreTokens(tokens, LATIN_LANGUAGE_STOPWORDS.fr),
  };

  for (const [language, words] of Object.entries(STRONG_LATIN_WORDS)) {
    scores[language] += scoreTokens(tokens, words) * 2;
  }

  scores.de += Math.min(4, countMatches(text, /[ÄÖÜäöüß]/gu)) * 2;
  scores.es += Math.min(4, countMatches(text, /[ÁÉÍÓÚáéíóúñÑ¿¡]/gu)) * 2;
  scores.fr += Math.min(4, countMatches(text, /[ÀÂÆÇÈÉÊËÎÏÔŒÙÛŸàâæçèéêëîïôœùûÿ]/gu)) * 2;

  const ranked = Object.entries(scores)
    .sort((left, right) => right[1] - left[1]);
  const [bestLanguage, bestScore] = ranked[0];
  const secondScore = ranked[1][1];
  const hasStrongSignal = bestScore >= 2 &&
    (bestScore > secondScore || bestScore >= 4);

  if (!hasStrongSignal) {
    return undefined;
  }

  return {
    confidence: Math.min(
      0.97,
      0.72 + Math.min(0.2, bestScore * 0.025) +
        Math.min(0.05, Math.max(0, bestScore - secondScore) * 0.01),
    ),
    language: bestLanguage,
    source: "local",
  };
}

function normalizeLanguageSample(input) {
  if (typeof input !== "string") {
    return "";
  }

  return input
    .slice(0, MAX_LANGUAGE_SAMPLE_CHARACTERS)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\\[A-Za-z]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreTokens(tokens, words) {
  return tokens.reduce(
    (score, token) => score + (words.has(token) ? 1 : 0),
    0,
  );
}

function countMatches(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}
