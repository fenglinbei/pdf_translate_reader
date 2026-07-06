import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { rerankEvidence } from "../../server/qa/reranker.mjs";

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "QA_RERANK_PROVIDER",
  "QA_RERANK_MODEL",
  "QA_RERANK_TOP_K",
  "QA_RERANK_CANDIDATE_LIMIT",
  "VOYAGE_API_KEY",
  "VOYAGE_API_BASE_URL",
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const evidence = [
  {
    chunkId: "chunk-1",
    cloudDocumentId: "doc-1",
    documentTitle: "Current Paper",
    evidenceId: "C1",
    pageEnd: 1,
    pageStart: 1,
    pdfFingerprint: "fp-1",
    score: 0.4,
    scoreBreakdown: { fullText: 0.2, metadataBoost: 0.1, vector: 0.5 },
    text: "Hybrid first candidate.",
    textPreview: "Hybrid first candidate.",
  },
  {
    chunkId: "chunk-2",
    cloudDocumentId: "doc-1",
    documentTitle: "Current Paper",
    evidenceId: "C2",
    pageEnd: 2,
    pageStart: 2,
    pdfFingerprint: "fp-1",
    score: 0.3,
    scoreBreakdown: { fullText: 0.3, metadataBoost: 0.1, vector: 0.4 },
    text: "Provider prefers this candidate.",
    textPreview: "Provider prefers this candidate.",
  },
];

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;

  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("rerankEvidence", () => {
  it("uses Voyage rerank scores and rewrites evidence ids after ranking", async () => {
    process.env.QA_RERANK_PROVIDER = "voyage";
    process.env.QA_RERANK_MODEL = "rerank-2.5";
    process.env.QA_RERANK_TOP_K = "2";
    process.env.VOYAGE_API_KEY = "test-key";
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.voyageai.com/v1/rerank");
      const body = JSON.parse(options.body);

      assert.equal(body.model, "rerank-2.5");
      assert.equal(body.query, "Which candidate is preferred?");
      assert.equal(body.documents.length, 2);

      return new Response(JSON.stringify({
        data: [
          { index: 1, relevance_score: 0.91 },
          { index: 0, relevance_score: 0.27 },
        ],
        usage: { total_tokens: 42 },
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };

    const result = await rerankEvidence({
      evidence,
      question: "Which candidate is preferred?",
    });

    assert.equal(result.warnings.length, 0);
    assert.equal(result.diagnostics.model, "rerank-2.5");
    assert.equal(result.usage.totalTokens, 42);
    assert.deepEqual(result.evidence.map((item) => item.chunkId), ["chunk-2", "chunk-1"]);
    assert.deepEqual(result.evidence.map((item) => item.evidenceId), ["C1", "C2"]);
    assert.equal(result.evidence[0].scoreBreakdown.rerank, 0.91);
  });

  it("falls back to hybrid order when rerank fails", async () => {
    process.env.QA_RERANK_PROVIDER = "voyage";
    process.env.QA_RERANK_TOP_K = "1";
    process.env.VOYAGE_API_KEY = "test-key";
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: { message: "provider unavailable" },
    }), {
      headers: { "Content-Type": "application/json" },
      status: 503,
    });

    const result = await rerankEvidence({
      evidence,
      question: "Trigger failure",
    });

    assert.equal(result.diagnostics.skippedReason, "reranker_failed");
    assert.match(result.warnings[0], /provider unavailable/);
    assert.deepEqual(result.evidence.map((item) => item.chunkId), ["chunk-1"]);
    assert.equal(result.evidence[0].scoreBreakdown.rerank, undefined);
  });
});
