import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAdaptiveReasoningProgressPolicy,
  getReasoningProgressEffortConfig,
} from "../../server/translationModels/reasoningProgressPolicy.mjs";
import {
  createReasoningSegmenter,
} from "../../server/translationModels/reasoningSegmenter.mjs";

describe("adaptive translation reasoning progress", () => {
  it("finds the same semantic units across arbitrary provider chunks", () => {
    const reasoning = [
      "先理解整段的核心含义。",
      "接下来核对专业术语与上下文。\n\n",
      "1. 检查指代关系\n",
      "最后复核格式与公式。",
    ].join("");
    const whole = createReasoningSegmenter();
    const chunked = createReasoningSegmenter();
    const wholeUnits = whole.push(reasoning);
    const chunkedUnits = [
      ...chunked.push(reasoning.slice(0, 7)),
      ...chunked.push(reasoning.slice(7, 19)),
      ...chunked.push(reasoning.slice(19, 35)),
      ...chunked.push(reasoning.slice(35)),
    ];

    assert.deepEqual(
      chunkedUnits.map(projectUnit),
      wholeUnits.map(projectUnit),
    );
    assert.deepEqual(
      wholeUnits.map((unit) => unit.boundary),
      ["sentence", "paragraph", "step", "sentence"],
    );
    assert.equal(wholeUnits[1].transition, true);
    assert.deepEqual(
      wholeUnits.map((unit) => [unit.startOffset, unit.endOffset]),
      wholeUnits
        .map((unit, index) => [
          index === 0 ? 0 : wholeUnits[index - 1].endOffset,
          unit.endOffset,
        ]),
    );
  });

  it("does not split at sentence punctuation inside fenced code or LaTeX", () => {
    const segmenter = createReasoningSegmenter();
    const units = segmenter.push([
      "```text\n",
      "do.not.split();\n",
      "```\n",
      "需要保留公式 $a.b$，然后检查句法。",
    ].join(""));

    assert.equal(units.length, 2);
    assert.match(units[0].text, /do\.not\.split/);
    assert.equal(units[0].boundary, "step");
    assert.match(units[1].text, /\$a\.b\$/);
  });

  it("waits across a provider chunk before classifying an ASCII period", () => {
    const whole = createReasoningSegmenter();
    const chunked = createReasoningSegmenter();
    const reasoning = "版本 1.2 需要继续核对。";
    const expected = whole.push(reasoning);
    const actual = [
      ...chunked.push("版本 1."),
      ...chunked.push("2 需要继续核对。"),
    ];

    assert.deepEqual(actual.map(projectUnit), expected.map(projectUnit));
    assert.equal(actual.length, 1);
  });

  it("emits a forced safety unit without silently dropping a long tail", () => {
    const segmenter = createReasoningSegmenter({
      maxIncompleteUnitCharacters: 512,
    });
    const units = segmenter.push("长".repeat(700));
    const snapshot = segmenter.snapshot();

    assert.equal(units.length, 1);
    assert.equal(units[0].boundary, "forced");
    assert.equal(
      units[0].text.length + snapshot.incompleteCharacters,
      700,
    );
    assert.equal(snapshot.nextOffset, 700);
  });

  it("uses effort-specific cadence and widened safety budgets", () => {
    const counts = Object.fromEntries(
      ["low", "high", "max"].map((effort) => {
        const policy = createAdaptiveReasoningProgressPolicy({ effort });
        let candidates = 0;

        for (let index = 0; index < 12; index += 1) {
          candidates += Number(policy.observe({
            boundary: "sentence",
            text: `一般分析内容 ${index}`,
            transition: false,
          }).shouldCreateCandidate);
        }

        return [effort, candidates];
      }),
    );

    assert.ok(counts.low <= counts.high);
    assert.ok(counts.high < counts.max);
    assert.deepEqual(
      Object.fromEntries(
        ["low", "high", "max"].map((effort) => {
          const config = getReasoningProgressEffortConfig(effort);

          return [
            effort,
            [
              config.softPartLimit,
              config.hardPartLimit,
              config.attemptLimit,
              config.maxQueuedCandidates,
            ],
          ];
        }),
      ),
      {
        high: [10, 16, 24, 3],
        low: [6, 8, 12, 2],
        max: [16, 24, 36, 4],
      },
    );
  });

  it("immediately creates a candidate when the inferred phase changes", () => {
    const policy = createAdaptiveReasoningProgressPolicy({ effort: "low" });

    assert.equal(policy.observe({
      boundary: "sentence",
      text: "先理解整段的核心语义。",
      transition: false,
    }).shouldCreateCandidate, false);
    const transition = policy.observe({
      boundary: "sentence",
      text: "现在核对关键术语的对应关系。",
      transition: false,
    });

    assert.equal(transition.shouldCreateCandidate, true);
    assert.equal(transition.reason, "phase-change");
    assert.equal(transition.phaseHint, "terminology");
  });

  it("applies semantic-boundary sensitivity according to effort", () => {
    const firstParagraphDecisions = Object.fromEntries(
      ["low", "high", "max"].map((effort) => {
        const policy = createAdaptiveReasoningProgressPolicy({ effort });

        return [
          effort,
          policy.observe({
            boundary: "paragraph",
            text: "然后，继续处理一般内容。",
            transition: true,
          }).shouldCreateCandidate,
        ];
      }),
    );

    assert.deepEqual(firstParagraphDecisions, {
      high: false,
      low: false,
      max: true,
    });
  });

  it("only permits major phase progress after the soft public limit", () => {
    const policy = createAdaptiveReasoningProgressPolicy({ effort: "low" });

    const first = policy.assessPublicUpdate({
      change: "material",
      partCount: 0,
      phase: "comprehension",
    });
    assert.equal(first.publish, true);
    policy.recordPublishedPhase(first.phase);
    assert.equal(policy.assessPublicUpdate({
      change: "material",
      partCount: 6,
      phase: "comprehension",
    }).publish, false);
    assert.equal(policy.assessPublicUpdate({
      change: "material",
      partCount: 6,
      phase: "terminology",
    }).publish, true);
    assert.equal(policy.assessPublicUpdate({
      change: "major",
      partCount: 8,
      phase: "verification",
    }).publish, false);
  });

  it("does not advance published phase until the caller accepts an update", () => {
    const policy = createAdaptiveReasoningProgressPolicy({ effort: "high" });
    const rejected = policy.assessPublicUpdate({
      change: "material",
      partCount: 0,
      phase: "terminology",
    });
    const retried = policy.assessPublicUpdate({
      change: "material",
      partCount: 0,
      phase: "terminology",
    });

    assert.equal(rejected.publish, true);
    assert.equal(retried.publish, true);
    assert.equal(retried.phaseChanged, false);
  });
});

function projectUnit(unit) {
  return {
    boundary: unit.boundary,
    endOffset: unit.endOffset,
    startOffset: unit.startOffset,
    text: unit.text,
    transition: unit.transition,
  };
}
