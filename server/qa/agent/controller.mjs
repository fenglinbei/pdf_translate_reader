import { CURRENT_PAPER_TOOL_DEFINITIONS } from "./tools.mjs";
import { normalizeEvidenceIds } from "./evidence.mjs";
import { normalizePositiveInteger, truncateForController } from "./values.mjs";

const CONTROLLER_ACTIONS = new Set([
  ...CURRENT_PAPER_TOOL_DEFINITIONS.map((tool) => tool.name),
  "finish_retrieval",
  "direct_answer",
]);

// complete({ messages, model, signal, temperature }) -> { content }
// Keep provider request mapping in the shared client used by translation and QA.
export function createQaControllerAdapter({ complete }) {
  if (typeof complete !== "function") throw new TypeError("A chat completion adapter is required.");
  return async function callReasoningController({
    budget,
    chatContext,
    evidence,
    model,
    openedEvidenceIds,
    queryPlan,
    question,
    signal,
    toolHistory,
    turnIndex,
  }) {
    const result = await complete({
      messages: buildReasoningControllerMessages({
        budget,
        chatContext,
        evidence,
        openedEvidenceIds,
        queryPlan,
        question,
        toolHistory,
        turnIndex,
      }),
      model,
      signal,
      temperature: 0.1,
    });

    return parseControllerJson(result.content);
  };
}

export function buildReasoningControllerMessages({
  budget,
  chatContext,
  evidence,
  openedEvidenceIds,
  queryPlan,
  question,
  toolHistory,
  turnIndex,
}) {
  return [
    {
      role: "system",
      content: [
        "You are a retrieval controller for current-paper QA.",
        "Return only one JSON object. Do not wrap it in Markdown.",
        "Do not reveal chain-of-thought. Put only a concise user-visible rationale in summary.",
        "Decide whether the user's message actually needs evidence from the paper before searching.",
        "Use direct_answer (not search_current_paper) when the message does NOT require paper content, such as:",
        "- greetings, thanks, or social replies (hi, hello, thanks, 嗨, 你好, 谢谢)",
        "- questions about your identity or capabilities (who are you, what can you do)",
        "- meta questions about the conversation (can you explain your previous answer)",
        "- general-knowledge questions unrelated to the paper's specific content",
        "Anything that depends on THIS paper's content (methods, results, figures, claims) MUST use search_current_paper.",
        "Allowed actions:",
        '{"action":"search_current_paper","summary":"...","query":"...","topK":8}',
        '{"action":"open_chunk","summary":"...","evidenceIds":["C1"]}',
        '{"action":"finish_retrieval","summary":"...","evidenceIds":["C1","C2"],"answerOutline":"..."}',
        '{"action":"direct_answer","summary":"...","reason":"greeting|chitchat|meta|general_knowledge","replyOutline":"brief reply outline"}',
        "All retrieval must stay inside the current paper.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        budget: {
          effort: budget.effectiveEffort,
          maxEvidence: budget.maxEvidence,
          maxOpenCalls: budget.maxOpenCalls,
          maxRetrievalCalls: budget.maxRetrievalCalls,
        },
        currentEvidence: evidence.map((item) => ({
          evidenceId: item.evidenceId,
          opened: openedEvidenceIds.includes(item.evidenceId),
          page: item.pageStart,
          preview: openedEvidenceIds.includes(item.evidenceId)
            ? truncateForController(item.text ?? item.textPreview, 3000)
            : truncateForController(item.textPreview, 800),
          score: item.score,
          sectionPath: item.sectionPath,
        })),
        conversationContext: chatContext,
        queryPlan,
        question,
        toolHistory: toolHistory.slice(-6),
        turnIndex,
      }),
    },
  ];
}

export function parseControllerJson(content) {
  const text = String(content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
  }

  throw new Error("Reasoning controller returned invalid JSON.");
}

export function normalizeControllerAction(action) {
  if (!action || typeof action !== "object") {
    throw new Error("Reasoning controller action must be an object.");
  }

  const actionName = typeof action.action === "string" ? action.action : "";

  if (!CONTROLLER_ACTIONS.has(actionName)) {
    throw new Error(`Reasoning controller returned unsupported action: ${actionName || "missing"}.`);
  }

  return {
    action: actionName,
    answerOutline: typeof action.answerOutline === "string" ? action.answerOutline.trim() : undefined,
    evidenceIds: normalizeEvidenceIds(action.evidenceIds),
    query: typeof action.query === "string" ? action.query.trim() : undefined,
    reason: typeof action.reason === "string" ? action.reason.trim() : undefined,
    replyOutline: typeof action.replyOutline === "string" ? action.replyOutline.trim() : undefined,
    summary: typeof action.summary === "string" ? action.summary.trim() : undefined,
    topK: normalizePositiveInteger(action.topK, undefined),
  };
}

export function normalizeControllerQuery(query, fallback) {
  const normalized = String(query ?? "").replace(/\s+/g, " ").trim();

  return normalized || fallback;
}
