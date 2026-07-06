import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQaChunks } from "../../server/qa/chunker.mjs";

describe("createQaChunks", () => {
  it("creates stable chunks with page ranges and section paths", () => {
    const document = {
      pages: [
        {
          lines: [
            "Introduction",
            "This paper studies retrieval augmented reading for scientific PDFs.",
            "The method keeps citation evidence attached to page level text.",
          ],
          pageNumber: 1,
          sectionsByLine: [
            ["Introduction"],
            ["Introduction"],
            ["Introduction"],
          ],
        },
        {
          lines: [
            "Methods",
            "The pipeline first parses MathPix pages and then writes stable chunks.",
            "The embedding stage uses a provider abstraction with a degraded fallback.",
          ],
          pageNumber: 2,
          sectionsByLine: [
            ["Methods"],
            ["Methods"],
            ["Methods"],
          ],
        },
      ],
      title: "Paper QA",
    };

    const chunks = createQaChunks({
      chunkerVersion: "qa-chunker-test",
      document,
      source: "mathpix-v3-pdf",
    });
    const secondPass = createQaChunks({
      chunkerVersion: "qa-chunker-test",
      document,
      source: "mathpix-v3-pdf",
    });

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].pageStart, 1);
    assert.equal(chunks[0].pageEnd, 2);
    assert.deepEqual(chunks[0].sectionPath, ["Introduction"]);
    assert.equal(chunks[0].chunkHash, secondPass[0].chunkHash);
    assert.match(chunks[0].chunkHash, /^sha256-[0-9a-f]{64}$/);
  });
});
