import { createQaChatCompletion } from "../chatModels/client.mjs";
import { QA_QUERY_ROUTER_VERSION } from "./config.mjs";

const VALID_TYPES = new Set(["global", "detail", "chitchat", "follow_up"]);
const VALID_CONFIDENCES = new Set(["high", "medium", "low"]);

export async function classifyQuestionType({ chatContext, model, question, signal }) {
  try {
    const result = await createQaChatCompletion({
      messages: buildRouterMessages({ chatContext, question }),
      model,
      signal,
      temperature: 0,
    });
    const parsed = parseRouterJson(result.content);
    const normalized = normalizeRouterResult(parsed);

    console.log("[query-router]", JSON.stringify({
      question: String(question ?? "").slice(0, 80),
      rawContent: String(result.content ?? "").slice(0, 200),
      normalizedType: normalized?.type,
      confidence: normalized?.confidence,
    }));

    if (!normalized || !VALID_TYPES.has(normalized.type)) {
      return createFallbackResult("router returned an unsupported type");
    }

    return normalized;
  } catch (error) {
    console.log("[query-router] error:", error instanceof Error ? error.message : error);
    return createFallbackResult(error instanceof Error ? error.message : "router call failed");
  }
}

function buildRouterMessages({ chatContext, question }) {
  const conversationSummary = summarizeChatContext(chatContext);

  return [
    {
      role: "system",
      content: [
        "You are a question-type router for an academic-paper QA system.",
        "Classify the user's question into exactly one of these types:",
        "- global: asks for a whole-paper summary, overview, core contribution, methodology outline, structure/logic walkthrough, or any synthesis that spans the entire paper. Examples: 'summarize this paper', 'what is the main contribution', 'walk me through the method', '梳理一下论证链', '讲讲这篇文章的行文逻辑', '这篇论文的核心思路是什么', '概括一下全文'.",
        "- detail: asks about a specific part that needs locating evidence (a formula, an experiment's accuracy, a comparison between A and B, a figure, a page). Examples: 'what is the formula on page 3', 'accuracy of experiment 2', 'compare method A and B', '第3页的公式是什么'.",
        "- chitchat: greetings, thanks, or questions about the assistant's identity/capabilities. Examples: 'hi', 'thanks', 'what can you do'.",
        "- follow_up: depends on the previous turn's context (pronouns, 'the second point', 'explain that'). Examples: 'what does it refer to', 'expand on the second point'.",
        "Return only one JSON object. Do not wrap it in Markdown.",
        'Format: {"type":"global|detail|chitchat|follow_up","confidence":"high|medium|low","reason":"short rationale"}',
        "Key heuristic: if the question asks about the paper's overall structure, logic, narrative flow, or asks to summarize/explain the whole paper, classify it as 'global'. Reserve 'detail' for questions targeting a specific fact, number, or local passage.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        conversationContext: conversationSummary,
        question,
      }),
    },
  ];
}

function summarizeChatContext(chatContext) {
  if (!chatContext || typeof chatContext !== "object") {
    return undefined;
  }

  const recentMessages = Array.isArray(chatContext.recentMessages) ? chatContext.recentMessages : [];

  if (recentMessages.length === 0) {
    return undefined;
  }

  return {
    userIntent: chatContext.userIntent,
    recentMessages: recentMessages.slice(-3).map((message) => ({
      role: message?.role,
      content: typeof message?.content === "string" ? message.content.slice(0, 200) : undefined,
    })),
  };
}

function parseRouterJson(content) {
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

  return undefined;
}

function normalizeRouterResult(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const type = typeof parsed.type === "string" ? parsed.type.trim() : "";
  const confidence = typeof parsed.confidence === "string" ? parsed.confidence.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";

  return {
    type,
    confidence: VALID_CONFIDENCES.has(confidence) ? confidence : "medium",
    reason: reason || undefined,
    routerVersion: QA_QUERY_ROUTER_VERSION,
  };
}

function createFallbackResult(reason) {
  return {
    type: "detail",
    confidence: "low",
    reason,
    routerVersion: QA_QUERY_ROUTER_VERSION,
    fallback: true,
  };
}
