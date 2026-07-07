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

  it("preserves LaTeX mmd from page latexByLine when available", () => {
    const document = {
      pages: [
        {
          latexByLine: [
            undefined,
            "The loss is \\( L = \\frac{1}{N} \\sum_i l_i \\).",
            "We optimize \\( L \\) with Adam.",
          ],
          lines: [
            "Introduction",
            "The loss is L = (1/N) sum_i l_i.",
            "We optimize L with Adam.",
          ],
          pageNumber: 1,
          sectionsByLine: [
            ["Introduction"],
            ["Introduction"],
            ["Introduction"],
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

    assert.equal(chunks.length, 1);
    // mmd joins only the lines that carry latex (header line is skipped)
    const expectedMmd = [
      "The loss is \\( L = \\frac{1}{N} \\sum_i l_i \\).",
      "We optimize \\( L \\) with Adam.",
    ].join("\n").trim();
    assert.equal(chunks[0].mmd, expectedMmd);
    // text stays plain (no LaTeX backslashes from frac)
    assert.doesNotMatch(chunks[0].text, /\\\\frac/);
  });

  it("falls back to undefined mmd when no latex is available", () => {
    const document = {
      pages: [
        {
          lines: ["Plain text only.", "No formulas here."],
          pageNumber: 1,
          sectionsByLine: [["Intro"], ["Intro"]],
        },
      ],
      title: "Paper QA",
    };

    const chunks = createQaChunks({
      chunkerVersion: "qa-chunker-test",
      document,
      source: "mathpix-v3-pdf",
    });

    assert.equal(chunks[0].mmd, undefined);
  });
});
