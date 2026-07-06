import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { embedTexts } from "../../server/embedding/client.mjs";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe("embedTexts", () => {
  it("calls Voyage embeddings with document input type and parses vectors", async () => {
    let requestBody;

    process.env.VOYAGE_API_KEY = "test-key";
    process.env.EMBEDDING_PROVIDER = "voyage";
    process.env.EMBEDDING_MODEL = "voyage-4-large";
    process.env.EMBEDDING_DIMENSIONS = "3";

    globalThis.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);

      return new Response(JSON.stringify({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0 },
          { embedding: [0.4, 0.5, 0.6], index: 1 },
        ],
        model: "voyage-4-large",
        usage: { total_tokens: 12 },
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    };

    const result = await embedTexts({
      inputType: "document",
      texts: ["alpha", "beta"],
    });

    assert.deepEqual(requestBody, {
      input: ["alpha", "beta"],
      input_type: "document",
      model: "voyage-4-large",
      output_dimension: 3,
      output_dtype: "float",
    });
    assert.deepEqual(result.vectors, [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ]);
    assert.deepEqual(result.usage, { totalTokens: 12 });
  });
});
