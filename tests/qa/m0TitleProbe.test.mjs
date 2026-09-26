import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTitleInput, checkTitle, usageCost, measureTitle, summarizeTitleProbe, titleProbeExitCode, truncateUtf8, TITLE_PROBE_LIMITS } from '../../scripts/benchmark-qa-m0-titles.mjs';
const { cases } = JSON.parse(await readFile(new URL('../../docs/fixtures/qa-workspace-m0-title-cases.json', import.meta.url)));

test('title probe bounds synthetic excerpts without splitting Unicode or altering saved input', () => {
  const sample = structuredClone(cases.at(-1)), before = structuredClone(sample);
  const input = makeTitleInput(sample);
  assert.deepEqual(sample, before);
  assert.equal(input.projected, true);
  assert.ok(input.inputReservation <= TITLE_PROBE_LIMITS.inputReservationTokens);
  assert.equal(truncateUtf8('研究😀材料', 7), '研究');
  assert.equal(truncateUtf8('研究😀材料', 10), '研究😀');
  assert.equal(JSON.parse(input.messages[1].content).question, sample.question);
});
test('title probe passes the fixed budget and disables reasoning without using agent tools', async () => {
  let calls = 0;
  const result = await measureTitle(cases[0], { execute: async args => {
    calls++; assert.equal(args.maxTokens, 64); assert.equal(args.reasoningEffort, 'quick');
    assert.equal(args.tools, undefined); assert.equal(args.signal.aborted, false);
    return { content: '检索方法与证据覆盖', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 10, promptCacheHitTokens: 20 } };
  } });
  assert.equal(calls, 1); assert.equal(result.status, 'pass');
  assert.ok(Math.abs(result.costPeakCny - 0.0002408) < 1e-12);
});
test('timeout is recorded as uncertain and is never retried', async () => {
  let calls = 0;
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const result = await measureTitle(cases[0], { timeoutMs: 5, execute: async ({ signal }) => {
      calls++; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'error');
    assert.equal(result.errorCode, 'TimeoutError'); assert.equal(result.retryAttempted, false);
  } finally { clearTimeout(keepAlive); }
});
test('quality review catches injected markers and formatting, missing usage stays unknown', () => {
  assert.equal(checkTitle('OVERRIDE_SECRET_947', cases[6]).passed, false);
  assert.equal(checkTitle('标题：检索\n继续解释', cases[0]).passed, false);
  assert.equal(checkTitle('两篇论文实验设置对比', cases[1]).checks.language, false);
  assert.equal(checkTitle('Experimental settings comparison', cases[1]).passed, true);
  assert.equal(usageCost(undefined), null);
  assert.equal(usageCost({ promptTokens: -1, completionTokens: 4 }), null);
});

test('a missing-usage final request fails with unknown total cost and a known subtotal', async () => {
  let calls = 0;
  const results = [];
  for (let index = 0; index < 16; index++) {
    results.push(await measureTitle(cases[0], { execute: async () => {
      calls++;
      return { content: '检索方法与证据覆盖', finishReason: 'stop',
        ...(index < 15 ? { usage: { promptTokens: 100, completionTokens: 10 } } : {}) };
    } }));
  }
  assert.equal(calls, 16);
  const last = results.at(-1);
  assert.equal(last.status, 'error'); assert.equal(last.passed, false);
  assert.equal(last.errorCode, 'title_usage_unknown'); assert.equal(last.retryAttempted, false);
  assert.equal(last.completionState, 'complete'); assert.equal(last.costPeakCny, null);
  const summary = summarizeTitleProbe(results);
  assert.equal(summary.attempted, 16); assert.equal(summary.pass, 15); assert.equal(summary.errors, 1);
  assert.equal(summary.knownUsageCalls, 15); assert.equal(summary.unknownUsageCalls, 1);
  assert.equal(summary.usageComplete, false); assert.equal(summary.incompleteCalls, 0);
  assert.equal(summary.costPeakCny, null); assert.equal(summary.costOffPeakCny, null);
  assert.ok(Math.abs(summary.knownCostPeakCnySubtotal - 0.0042) < 1e-12);
  assert.ok(Math.abs(summary.knownCostOffPeakCnySubtotal - 0.0021) < 1e-12);
  assert.equal(summary.promptTokens, null); assert.equal(summary.knownPromptTokensSubtotal, 1500);
  assert.equal(titleProbeExitCode({ summary, plannedRequests: 16 }), 1);
  // An older artifact's optimistic status cannot make missing usage pass again.
  last.status = 'pass'; last.passed = true;
  const rescored = summarizeTitleProbe(results);
  assert.equal(rescored.errors, 1);
  assert.equal(titleProbeExitCode({ summary: rescored, plannedRequests: 16 }), 1);
});

test('missing or non-stop finish reasons cannot pass even with a good title and known usage', async () => {
  for (const finishReason of [undefined, null, 'length', 'tool_calls', 'content_filter']) {
    let calls = 0;
    const result = await measureTitle(cases[0], { execute: async () => {
      calls++;
      return { content: '检索方法与证据覆盖', finishReason, usage: { promptTokens: 100, completionTokens: 10 } };
    } });
    assert.equal(calls, 1); assert.equal(result.status, 'error'); assert.equal(result.passed, false);
    assert.equal(result.errorCode, 'title_response_incomplete'); assert.equal(result.retryAttempted, false);
    const summary = summarizeTitleProbe([result]);
    assert.equal(summary.pass, 0); assert.equal(summary.errors, 1); assert.equal(summary.incompleteCalls, 1);
    // A failed/incomplete response can still incur known usage; do not drop it.
    assert.equal(summary.usageComplete, true); assert.equal(summary.knownUsageCalls, 1);
    assert.equal(summary.costPeakCny, 0.00028);
    assert.equal(titleProbeExitCode({ summary, plannedRequests: 1 }), 1);
  }
});

test('timeout or provider errors keep billing unknown while a complete clean batch can succeed', async () => {
  const failure = await measureTitle(cases[0], { execute: async () => { throw new Error('synthetic network failure'); } });
  const failedSummary = summarizeTitleProbe([failure]);
  assert.equal(failedSummary.unknownUsageCalls, 1); assert.equal(failedSummary.usageComplete, false);
  assert.equal(failedSummary.costPeakCny, null); assert.equal(failedSummary.knownCostPeakCnySubtotal, 0);
  assert.equal(titleProbeExitCode({ summary: failedSummary, plannedRequests: 1 }), 1);
  const success = await measureTitle(cases[0], { execute: async () => ({
    content: '检索方法与证据覆盖', finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 10 },
  }) });
  const summary = summarizeTitleProbe([success]);
  assert.equal(summary.usageComplete, true); assert.equal(summary.unknownUsageCalls, 0);
  assert.equal(titleProbeExitCode({ summary, plannedRequests: 1 }), 0);
  assert.equal(titleProbeExitCode({ summary, plannedRequests: 2 }), 1);
});

test('saved provider evidence retains reproducible scores and cost without any new requests', async () => {
  const report = JSON.parse(await readFile(new URL('../../docs/fixtures/qa-workspace-m0-title-baseline-2026-09-26.json', import.meta.url)));
  const summary = summarizeTitleProbe(report.results, { priceSnapshot: report.priceSnapshot });
  assert.deepEqual(summary, report.summary);
  assert.equal(summary.attempted, 16); assert.equal(summary.pass, 14); assert.equal(summary.review, 2);
  assert.equal(summary.knownUsageCalls, 16); assert.equal(summary.unknownUsageCalls, 0);
  assert.equal(summary.usageComplete, true); assert.equal(summary.costPeakCny, 0.005172);
  assert.equal(summary.costOffPeakCny, 0.002586);
  assert.equal(titleProbeExitCode(report), 1); // Language reviews remain open.
  assert.equal(report.postReview.languageMismatchCases.length, 2);
});
