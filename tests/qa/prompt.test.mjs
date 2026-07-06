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
});
