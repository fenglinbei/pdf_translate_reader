import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractCitationIds,
  verifyAnswerCitations,
} from "../../server/qa/citationVerifier.mjs";

const evidence = [
  {
    chunkId: "chunk-1",
    cloudDocumentId: "doc-1",
    documentTitle: "Current Paper",
    evidenceId: "C1",
    pageEnd: 2,
    pageStart: 2,
    pdfFingerprint: "fp-1",
    sectionPath: ["Methods"],
    text: "The method retrieves chunks and verifies citations.",
    textPreview: "The method retrieves chunks and verifies citations.",
  },
  {
    chunkId: "chunk-2",
    cloudDocumentId: "doc-1",
    documentTitle: "Current Paper",
    evidenceId: "C2",
    pageEnd: 5,
    pageStart: 4,
    pdfFingerprint: "fp-1",
    text: "The experiment reports the main results.",
    textPreview: "The experiment reports the main results.",
  },
];

describe("verifyAnswerCitations", () => {
  it("saves only citations that came from the current retrieval evidence", () => {
    const result = verifyAnswerCitations({
      answerText: "The system verifies cited chunks [C1], but this citation is invalid [C99].",
      evidence,
    });

    assert.equal(result.citations.length, 1);
    assert.equal(result.citations[0].chunkId, "chunk-1");
    assert.equal(result.citations[0].confidence, "verified");
    assert.deepEqual(result.rejected, [
      {
        confidence: "rejected",
        evidenceId: "C99",
        reason: "citation_not_in_retrieval",
      },
    ]);
    assert.equal(result.warnings.length, 1);
  });

  it("deduplicates repeated citation ids in answer order", () => {
    assert.deepEqual(extractCitationIds("Use [C2], then [C1], and [C2] again."), ["C2", "C1"]);
  });
});
