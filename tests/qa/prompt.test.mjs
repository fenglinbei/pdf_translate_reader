import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildQaAnswerMessages,
  createRetrievalSnapshot,
} from "../../server/qa/prompt.mjs";

describe("QA prompt helpers", () => {
  it("builds an evidence-only answer prompt with stable evidence ids", () => {
    const messages = buildQaAnswerMessages({
      answerLanguage: "en",
      evidence: [
        {
          documentTitle: "Paper QA",
          evidenceId: "C1",
          pageEnd: 3,
          pageStart: 3,
          sectionPath: ["Retrieval"],
          text: "The answer must cite retrieved evidence.",
        },
      ],
      question: "How does citation verification work?",
    });

    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /Answer only from the provided evidence pack/);
    assert.match(messages[1].content, /\[C1\]/);
    assert.match(messages[1].content, /Pages: p\.3/);
  });

  it("stores retrieval snapshots with previews instead of full prompt text", () => {
    const snapshot = createRetrievalSnapshot({
      activeDocumentId: "doc-1",
      evidence: [
        {
          chunkId: "chunk-1",
          cloudDocumentId: "doc-1",
          documentTitle: "Paper QA",
          evidenceId: "C1",
          pageEnd: 2,
          pageStart: 1,
          pdfFingerprint: "fp-1",
          score: 0.8,
          scoreBreakdown: { fullText: 0.2, metadataBoost: 0.1, vector: 0.9 },
          text: "Full text used only for prompt construction.",
          textPreview: "Preview text.",
        },
      ],
      queryPlan: {
        answerFormat: "paragraph",
        intent: "method",
        requiredEvidence: "single",
        rewrittenQueries: ["method"],
      },
      retrieverVersion: "hybrid-retriever-test",
    });

    assert.equal(snapshot.scope, "current");
    assert.equal(snapshot.evidence[0].textPreview, "Preview text.");
    assert.equal(Object.hasOwn(snapshot.evidence[0], "text"), false);
  });

  it("adds conversation context for follow-up questions without preserving old citation ids", () => {
    const messages = buildQaAnswerMessages({
      answerLanguage: "en",
      chatContext: {
        carryoverEvidence: [
          {
            evidenceId: "C2",
            textPreview: "Prior evidence preview.",
          },
        ],
        recentMessages: [
          {
            content: "Summarize the objective.",
            role: "user",
          },
          {
            content: "The objective is described in the method section [C2].",
            role: "assistant",
          },
        ],
        userIntent: "follow_up",
      },
      evidence: [
        {
          documentTitle: "Paper QA",
          evidenceId: "C1",
          pageEnd: 4,
          pageStart: 4,
          sectionPath: ["Method"],
          text: "The current evidence pack uses a fresh citation id.",
        },
      ],
      question: "Can you expand on that?",
    });

    assert.match(messages[0].content, /Conversation context may help resolve follow-up/);
    assert.match(messages[1].content, /\[Conversation context\]/);
    assert.match(messages[1].content, /User intent: follow_up/);
    assert.match(messages[1].content, /prior citation/);
    assert.doesNotMatch(messages[1].content, /method section \[C2\]/);
    assert.match(messages[1].content, /\[C1\]/);
  });

  it("appends a LaTeX block to evidence with mmd", () => {
    const messages = buildQaAnswerMessages({
      answerLanguage: "en",
      evidence: [
        {
          documentTitle: "Paper QA",
          evidenceId: "C1",
          mmd: "\\frac{a}{b} = c",
          pageEnd: 3,
          pageStart: 3,
          sectionPath: ["Method"],
          text: "The loss function is defined below.",
        },
      ],
      question: "What is the loss function?",
    });

    assert.match(messages[1].content, /Text:/);
    assert.match(messages[1].content, /LaTeX:/);
    assert.match(messages[1].content, /\\frac\{a\}\{b\} = c/);
  });

  it("builds a long-context prompt with the full paper text", () => {
    const messages = buildQaAnswerMessages({
      answerLanguage: "en",
      evidence: [],
      fullPaperText: "\\title{Sample Paper}\nThe whole paper goes here.",
      mode: "long_context",
      paperTitle: "Sample Paper",
      question: "Summarize this paper",
    });

    assert.match(messages[0].content, /whole-paper question/);
    assert.match(messages[1].content, /\[Full paper \(MathPix\)\]/);
    assert.match(messages[1].content, /The whole paper goes here\./);
    assert.match(messages[1].content, /\[Paper title\]/);
    assert.match(messages[1].content, /Sample Paper/);
  });
});
