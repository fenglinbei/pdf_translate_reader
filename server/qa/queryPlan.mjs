const MAX_QUERY_CHARS = 2000;

export function createQueryPlan(question) {
  const lowerQuestion = String(question ?? "").toLocaleLowerCase();
  const isComparison = /\b(compare|difference|versus|vs\.?|对比|比较|区别)\b/.test(lowerQuestion);
  const isSummary = /\b(summary|summarize|overview|总结|概括)\b/.test(lowerQuestion);
  const isResult = /\b(result|experiment|accuracy|性能|结果|实验)\b/.test(lowerQuestion);
  const isMethod = /\b(method|approach|algorithm|模型|方法|算法)\b/.test(lowerQuestion);
  const intent = isComparison
    ? "comparison"
    : isSummary
      ? "summary"
      : isResult
        ? "result"
        : isMethod
          ? "method"
          : "question";

  return {
    answerFormat: isComparison ? "table" : isSummary ? "bullets" : "paragraph",
    intent,
    requiredEvidence: isComparison ? "comparison" : isSummary ? "multi" : "single",
    rewrittenQueries: [normalizeQuestion(question)],
  };
}

export function normalizeQuestion(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}
