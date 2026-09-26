#!/usr/bin/env node
// Offline M0 harness baseline. Only isolated loopback HTTP; no real provider or external database.
// Run in an independently constrained container; see the companion runtime document.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { buildDocumentArtifact } from '../shared/qaDocumentBuilder.mjs';
import { packDocumentArtifact } from '../shared/qaDocumentParts.mjs';
import { createArtifactLoader } from '../server/qa/documentArtifacts/loader.mjs';
import { createArtifactWorkspace } from '../server/qa/documentArtifacts/tools.mjs';
import { handleWorkspaceStream } from '../server/qa/workspace/stream.mjs';
import { createDocumentRunContext } from '../server/qa/documents/runContext.mjs';
import { createStreamAdmission } from '../server/qa/streamAdmission.mjs';

const args = new Map(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  return index < 0 ? [arg, true] : [arg.slice(0, index), arg.slice(index + 1)];
}));
const output = args.get('--output');
const samples = Number(args.get('--samples') ?? 30);
const batches = Number(args.get('--batches') ?? 10);
const sourceSha = args.get('--source-sha');
assert(Number.isSafeInteger(samples) && samples >= 10 && samples <= 200);
assert(Number.isSafeInteger(batches) && batches >= 3 && batches <= 50);
assert(typeof sourceSha === 'string' && /^[a-f0-9]{40}$/.test(sourceSha), 'Pass the verified checkout SHA as --source-sha=<40 hex>.');
assert(typeof output === 'string', 'Pass --output=<path>.');
if (args.has('--aggregate')) {
  const files = String(args.get('--aggregate')).split(',');
  assert.equal(files.length, 3, 'Aggregation requires three fresh process runs.');
  const texts = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const runs = texts.map(text => JSON.parse(text)), first = runs[0];
  for (const run of runs) {
    assert.equal(run.sourceSha, sourceSha); assert.equal(run.environment.node, first.environment.node);
    assert(run.environment.limits.hardTwoCpuTwoGiB); assert(run.hardAssertions.allSatisfied);
    assert.equal(run.fixture.revision, first.fixture.revision);
    assert.deepEqual(run.scenarios.map(s => s.name), first.scenarios.map(s => s.name));
    assert(run.scenarios.find(s => s.name === 'document_read_warm').samples.every(s => s.artifactLoadedUtf8Bytes === 0 && s.artifactLoadCalls === 0));
  }
  const median = values => [...values].sort((a, b) => a - b)[1];
  const comparisonAnchors = first.scenarios.map((scenario, index) => {
    const measured = runs.map(run => run.scenarios[index]);
    const latency = measured.map(s => s.name === 'ten_users_one_queued_cancel' ? s.successfulLatencyMs : s.metrics);
    return { name: scenario.name, sampleCountsPerRun: measured.map(s => s.sampleCount),
      medianFirstDeltaP50Ms: median(latency.map(s => s.firstDeltaMs.p50)), medianFirstDeltaP95Ms: median(latency.map(s => s.firstDeltaMs.p95)),
      medianTotalP50Ms: median(latency.map(s => s.totalMs.p50)), medianTotalP95Ms: median(latency.map(s => s.totalMs.p95)),
      medianQueueWaitP95Ms: median(latency.map(s => s.queueWaitMs.p95)),
      terminalStatusesPerRun: measured.map(s => s.terminalStatuses),
      note: scenario.name === 'ten_users_one_queued_cancel' ? 'Latency anchors use only the nine successful requests per batch; queued-cancel timing remains in run summaries.' : 'Median of three independent run percentiles; not a pooled percentile.' };
  });
  const compactScenarios = run => run.scenarios.map(({ samples, ...summary }) => summary);
  const result = { schemaVersion: 'qa-m0-runtime-baseline-aggregate-v1', sourceSha, sourceShaMeaning: 'unchanged business runtime parent baseline; new benchmark script is identified separately by scriptSha256', measuredAt: runs.map(r => r.measuredAt),
    scriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    environment: first.environment, path: first.path, fixture: first.fixture, measurement: first.measurement,
    freshProcesses: 3, measuredRequests: runs.reduce((n, r) => n + r.scenarios.reduce((m, s) => m + s.sampleCount, 0), 0),
    comparisonAnchors, resources: { processMaxRssKiBPerRun: runs.map(r => r.resources.processMaxRssKiB),
      medianProcessMaxRssKiB: median(runs.map(r => r.resources.processMaxRssKiB)),
      cgroupMemoryPeakBytesPerRun: runs.map(r => r.resources.cgroupMemoryPeakBytes) },
    hardAssertions: first.hardAssertions, frozenComparisonPolicy: first.frozenComparisonPolicy, initialRuntimeBudgets: first.initialRuntimeBudgets,
    runs: runs.map((run, index) => ({ index: index + 1, measuredAt: run.measuredAt,
      rawResultSha256: createHash('sha256').update(texts[index]).digest('hex'), resources: run.resources, scenarios: compactScenarios(run) })),
    limitations: [...first.limitations, 'Committed aggregate retains per-run summaries and input hashes; single-run output from the same script contains individual request samples.'],
  };
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, measuredRequests: result.measuredRequests, freshProcesses: 3, comparisonAnchors }));
  process.exit(0);
}
// Unexpected network access is always an error, including a forgotten dependency injection.
const loopbackFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('M0_BENCHMARK_NETWORK_FORBIDDEN'); };
const round = n => Math.round(n * 1000) / 1000;
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const pickStats = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => sorted.length ? round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]) : null;
  return { count: sorted.length, min: sorted.length ? round(sorted[0]) : null, p50: percentile(0.5), p95: percentile(0.95), max: sorted.length ? round(sorted.at(-1)) : null };
};
const readMaybe = async file => { try { return (await readFile(file, 'utf8')).trim(); } catch { return null; } };
const cgroupPath = (await readMaybe('/proc/self/cgroup'))?.split('\n').find(line => line.startsWith('0::'))?.slice(3);
const cgroupBase = cgroupPath === '/' ? '/sys/fs/cgroup' : `/sys/fs/cgroup${cgroupPath ?? ''}`;
const limits = {
  cgroupPath, cpuMax: await readMaybe(`${cgroupBase}/cpu.max`), memoryMax: await readMaybe(`${cgroupBase}/memory.max`),
  memorySwapMax: await readMaybe(`${cgroupBase}/memory.swap.max`), cpusetEffective: await readMaybe(`${cgroupBase}/cpuset.cpus.effective`),
};
limits.hardTwoCpuTwoGiB = limits.cpuMax === '200000 100000' && limits.memoryMax === '2147483648' && limits.memorySwapMax === '0';
if (args.has('--require-hard-limits')) assert(limits.hardTwoCpuTwoGiB, 'Actual cgroup limits must be 2 CPU / 2 GiB / zero swap.');

// Parse/pack outside request timing. This measures already prepared artifact reading.
const paragraphs = Array.from({ length: 90 }, (_, i) => i === 0
  ? 'Gate weights fuse different branches. Calibration remains weak. The synthetic evidence describes architecture rather than treatment effects.'
  : `Paragraph ${String(i).padStart(2, '0')} contains independently generated evaluation observations. ` +
    'The synthetic setup keeps document identity and source ranges explicit. '.repeat(3));
const sourceText = '# Synthetic results\n\n' + paragraphs.join('\n\n');
const { artifact } = await buildDocumentArtifact({ pdfSha256: 'a'.repeat(64), mmd: sourceText,
  pages: [{ pageIndex: 0, lines: paragraphs.map((text, lineIndex) => ({ text, lineIndex })) }] });
const packed = await packDocumentArtifact(artifact);
const partFiles = new Map(packed.files.map(part => [part.id, part.text]));
let idCounter = 0;
let sampledPeakRssBytes = process.memoryUsage().rss;
function sampleRss() { const rss = process.memoryUsage().rss; sampledPeakRssBytes = Math.max(sampledPeakRssBytes, rss); return rss; }
const sampler = setInterval(sampleRss, 1); sampler.unref();
function storeFixture() {
  const io = { loadCalls: 0, loadedUtf8Bytes: 0, authorizations: 0 };
  const loader = createArtifactLoader({ authorize: async scope => {
    assert(scope.userId.startsWith('synthetic-user-'));
    assert.equal(scope.documentId, 'synthetic-document');
    io.authorizations++;
  }, loadText: async scope => {
    const text = scope.partId === 'manifest' ? packed.manifestText : partFiles.get(scope.partId);
    assert.equal(typeof text, 'string'); io.loadCalls++; io.loadedUtf8Bytes += bytes(text); return text;
  } });
  return { io, loader, snapshot: () => ({ ...io, ...loader.metrics }),
    load: async (scope, options) => ({ ...await loader.open({ ...scope, revision: artifact.revision,
      manifestSha256: packed.manifestSha256 }, options), title: 'Synthetic study', pdfFingerprint: 'synthetic-pdf' }) };
}
class SyntheticResponse extends EventEmitter {
  headersSent = false; writableEnded = false; destroyed = false;
  events = []; responseBytes = 0; firstDeltaAt = null; doneAt = null; peakRssBytes = 0;
  constructor(forward) {
    super(); this.forward = forward;
    forward?.on('drain', () => this.emit('drain'));
    forward?.once('close', () => { this.destroyed = true; this.emit('close'); });
  }
  get writableLength() { return this.forward?.writableLength ?? 0; }
  writeHead(...args) { this.headersSent = true; this.forward?.writeHead(...args); }
  flushHeaders() { this.forward?.flushHeaders(); }
  write(chunk) {
    this.responseBytes += bytes(chunk); this.peakRssBytes = Math.max(this.peakRssBytes, sampleRss());
    const event = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (event && data) {
      const payload = JSON.parse(data); this.events.push({ event, payload });
      if (event === 'delta' && payload.text && this.firstDeltaAt === null) {
        this.firstDeltaAt = performance.now();
        if (this.cancelOnFirstDelta) { this.destroyed = true; this.emit('close'); }
      }
      if (event === 'done') this.doneAt = performance.now();
    }
    return this.forward ? this.forward.write(chunk) : true;
  }
  end() { this.writableEnded = true; this.forward?.end(); }
  destroy() { this.destroyed = true; this.forward?.destroy(); this.emit('close'); }
}
function makeAdapter(kind, metrics) {
  return { async stream({ signal, onDelta, onUsage }) {
    metrics.modelCalls++;
    // Scheduling yields exercise interleaving and cancellation, with no inserted latency.
    await nextTurn(); signal.throwIfAborted();
    if ((kind === 'document_read' || kind === 'document_search_miss') && metrics.modelCalls === 1) {
      const name = kind === 'document_read' ? 'read_document' : 'search_document';
      const input = kind === 'document_read' ? { document: 'current' } : { documents: ['current'], queries: ['not-present-needle'] };
      const call = { id: 'synthetic-tool-1', name, arguments: JSON.stringify(input) };
      onUsage({ promptTokens: 100, completionTokens: 10 });
      return { message: { role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name, arguments: call.arguments } }] }, calls: [call], finishReason: 'tool_calls' };
    }
    const content = kind === 'document_read' ? 'Gate weights fuse branches [R1.1].'
      : kind === 'document_search_miss' ? 'This bounded synthetic search returned no matching excerpt.' : 'Synthetic ordinary answer.';
    for (let i = 0; i < content.length; i += 9) { signal.throwIfAborted(); onDelta(content.slice(i, i + 9)); await nextTurn(); }
    signal.throwIfAborted(); onUsage({ promptTokens: 100, completionTokens: 10 });
    return { message: { role: 'assistant', content }, calls: [], finishReason: 'stop' };
  } };
}
async function runRequest({ kind, userId = 'synthetic-user-single', fixture = storeFixture(), submittedAt = performance.now(), admittedAt = submittedAt, transportResponse }) {
  const response = new SyntheticResponse(transportResponse); response.cancelOnFirstDelta = kind === 'active_cancel';
  const metrics = { modelCalls: 0, dbReadCalls: 0, dbWriteCalls: 0, dbWrittenUtf8Bytes: 0, commits: 0, toolCalls: 0, terminalStatus: null };
  const before = fixture.snapshot();
  const runId = `synthetic-run-${++idCounter}`;
  const activeDocumentId = kind.startsWith('document_') ? 'synthetic-document' : undefined;
  const workspace = createArtifactWorkspace({ userId, runId, activeDocumentId, load: fixture.load });
  const persist = async value => { metrics.dbWriteCalls++; metrics.dbWrittenUtf8Bytes += bytes(value); return { ...value, id: `synthetic-row-${++idCounter}` }; };
  const db = {
    createOrReuseQaThread: async value => { await persist(value); return { id: `synthetic-thread-${idCounter}` }; },
    listQaMessagesForThread: async () => { metrics.dbReadCalls++; return []; },
    insertQaMessage: persist,
    updateQaMessage: async value => { metrics.terminalStatus = value.status; return persist(value); },
    commitArtifactAnswer: async value => { metrics.commits++; metrics.terminalStatus = 'success'; await persist(value);
      return { message: { id: value.messageId, content: value.content, status: 'success' }, citations: value.citations }; },
  };
  await handleWorkspaceStream({}, response, { id: userId }, { model: 'deepseek-flash', question: 'Synthetic question', activeDocumentId }, {
    artifacts: true, workspace, db, requireDocument: async ({ userId: owner }) => assert.equal(owner, userId),
    createAdapter: () => makeAdapter(kind, metrics),
    createContext: options => createDocumentRunContext({ ...options, persistStep: persist,
      persistTool: async value => { metrics.toolCalls++; return persist(value); }, persistLog: persist }),
  });
  const finishedAt = performance.now(), after = fixture.snapshot();
  const expectedCancel = kind === 'active_cancel';
  assert.equal(metrics.modelCalls, kind.startsWith('document_') ? 2 : 1);
  assert.equal(metrics.toolCalls, kind.startsWith('document_') ? 1 : 0);
  assert.equal(metrics.commits, expectedCancel ? 0 : 1);
  assert.equal(metrics.terminalStatus, expectedCancel ? 'aborted' : 'success');
  assert.equal(response.events.some(e => e.event === 'done'), !expectedCancel);
  const metadata = response.events.find(e => e.event === 'meta'); assert.equal(metadata?.payload.runtime, 'workspace-artifacts-v1');
  if (kind === 'document_read') assert.equal(response.events.find(e => e.event === 'done').payload.citations.length, 1);
  const w = workspace.metrics;
  if (kind === 'ordinary') assert.equal(w.returnedChars, 0);
  if (kind === 'document_search_miss') { assert(w.scanChars > 5000); assert.equal(w.returnedChars, 0); }
  return {
    firstDeltaMs: response.firstDeltaAt === null ? null : round(response.firstDeltaAt - submittedAt),
    totalMs: round(finishedAt - submittedAt), queueWaitMs: round(admittedAt - submittedAt),
    cancellationAfterFirstDeltaMs: expectedCancel ? round(finishedAt - response.firstDeltaAt) : null,
    ...metrics, returnedChars: w.returnedChars, scanChars: w.scanChars, documentsRead: w.documentsRead,
    artifactLoadCalls: after.loadCalls - before.loadCalls, artifactLoadedUtf8Bytes: after.loadedUtf8Bytes - before.loadedUtf8Bytes,
    authorizations: after.authorizations - before.authorizations, cacheHits: after.hits - before.hits, cacheMisses: after.misses - before.misses,
    cacheEstimatedResidentBytes: after.estimatedBytes, cacheEntries: after.entries, cacheEvictions: after.evictions - before.evictions,
    responseBytes: response.responseBytes, sampledPeakRssBytes: response.peakRssBytes,
  };
}
const scenarios = [];
function summarize(name, records, extra = {}) {
  const fields = ['firstDeltaMs', 'totalMs', 'queueWaitMs', 'cancellationAfterFirstDeltaMs', 'modelCalls', 'toolCalls', 'returnedChars', 'scanChars',
    'artifactLoadCalls', 'artifactLoadedUtf8Bytes', 'cacheHits', 'cacheMisses', 'cacheEstimatedResidentBytes', 'dbReadCalls', 'dbWriteCalls', 'dbWrittenUtf8Bytes', 'responseBytes'];
  return { name, sampleCount: records.length, terminalStatuses: Object.fromEntries([...new Set(records.map(r => r.terminalStatus))].map(status => [status, records.filter(r => r.terminalStatus === status).length])),
    successfulLatencyMs: Object.fromEntries(['firstDeltaMs', 'totalMs', 'queueWaitMs'].map(field => [field, pickStats(records.filter(r => r.terminalStatus === 'success').map(r => r[field]))])),
    metrics: Object.fromEntries(fields.map(field => [field, pickStats(records.map(r => r[field]))])),
    sampledPeakRssBytes: Math.max(...records.map(r => r.sampledPeakRssBytes ?? 0)), ...extra, samples: records };
}
for (const [name, kind, warm] of [['ordinary', 'ordinary', false], ['document_read_cold', 'document_read', false],
  ['document_read_warm', 'document_read', true], ['document_search_miss_cold', 'document_search_miss', false], ['active_cancel', 'active_cancel', false]]) {
  const shared = warm ? storeFixture() : undefined;
  for (let n = 0; n < 5; n++) await runRequest({ kind, fixture: shared ?? storeFixture() });
  const records = [];
  for (let n = 0; n < samples; n++) records.push(await runRequest({ kind, fixture: shared ?? storeFixture() }));
  scenarios.push(summarize(name, records, { warmupRequestsExcluded: 5, cacheMode: warm ? 'same-owner loader retained across warmup and measured requests' : 'new loader per request' }));
}
for (const cancelQueued of [false, true]) {
  const records = [], batchRecords = [];
  for (let batch = 0; batch < batches; batch++) {
    const scheduler = createStreamAdmission(), controllers = Array.from({ length: 10 }, () => new AbortController());
    let queuedPeak = 0; const startedOrder = [], cancelledUsers = [];
    const requests = controllers.map((controller, userIndex) => {
      const userId = `synthetic-user-${userIndex}`, submittedAt = performance.now();
      const acquisition = scheduler.acquire(userId, controller.signal);
      queuedPeak = Math.max(queuedPeak, scheduler.metrics.queued);
      return acquisition.then(async lease => {
        startedOrder.push(userIndex); const admittedAt = performance.now();
        try { return await runRequest({ kind: 'document_read', userId, submittedAt, admittedAt }); } finally { lease.release(); }
      }).catch(error => {
        if (!(cancelQueued && userIndex === 9 && error.name === 'AbortError')) throw error;
        cancelledUsers.push(userIndex);
        return { terminalStatus: 'queued_cancelled', totalMs: round(performance.now() - submittedAt), modelCalls: 0, toolCalls: 0, commits: 0 };
      });
    });
    if (cancelQueued) controllers[9].abort();
    const values = await Promise.all(requests); records.push(...values);
    assert.equal(scheduler.metrics.highWater, 2); assert.equal(queuedPeak, 8);
    assert.deepEqual(startedOrder, Array.from({ length: cancelQueued ? 9 : 10 }, (_, n) => n));
    assert.equal(cancelledUsers.length, cancelQueued ? 1 : 0);
    assert.equal(scheduler.metrics.active, 0); assert.equal(scheduler.metrics.queued, 0); assert.equal(scheduler.metrics.users, 0);
    batchRecords.push({ batch, activePeak: scheduler.metrics.highWater, queuedPeak, startedOrder, cancelledUsers,
      completed: values.filter(v => v.terminalStatus === 'success').length, final: scheduler.metrics });
  }
  scenarios.push(summarize(cancelQueued ? 'ten_users_one_queued_cancel' : 'ten_users_document_read', records, { batches: batchRecords, warmupRequestsExcluded: 0 }));
}
// Actual loopback HTTP/SSE boundary, still without product auth/provider/real DB.
let serverCompletion;
const loopbackServer = createServer((request, response) => {
  const kind = request.url === '/document' ? 'document_read' : 'ordinary';
  serverCompletion = runRequest({ kind, transportResponse: response });
  serverCompletion.catch(() => response.destroy());
});
await new Promise((resolve, reject) => {
  loopbackServer.once('error', reject);
  loopbackServer.listen(0, '127.0.0.1', resolve);
});
async function runHttpRequest(kind) {
  const startedAt = performance.now();
  const target = `http://127.0.0.1:${loopbackServer.address().port}/${kind === 'document_read' ? 'document' : 'ordinary'}`;
  const response = await loopbackFetch(target);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  let firstDeltaAt = null, doneAt = null, pending = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1], data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'delta' && payload.text && firstDeltaAt === null) firstDeltaAt = performance.now();
      if (event === 'done') doneAt = performance.now();
      assert.notEqual(event, 'error');
    }
  }
  const finishedAt = performance.now(), server = await serverCompletion;
  assert.notEqual(firstDeltaAt, null); assert.notEqual(doneAt, null);
  return { ...server, serverFirstDeltaMs: server.firstDeltaMs, serverTotalMs: server.totalMs,
    firstDeltaMs: round(firstDeltaAt - startedAt), totalMs: round(finishedAt - startedAt), clientDoneMs: round(doneAt - startedAt) };
}
try {
  for (const kind of ['ordinary', 'document_read']) {
    for (let n = 0; n < 5; n++) await runHttpRequest(kind);
    const records = [];
    for (let n = 0; n < samples; n++) records.push(await runHttpRequest(kind));
    scenarios.push(summarize(`http_loopback_${kind}`, records, { warmupRequestsExcluded: 5,
      transport: 'actual HTTP loopback server, native fetch and SSE frame decoding; fresh loader per request',
      serverLatencyMs: { firstDelta: pickStats(records.map(r => r.serverFirstDeltaMs)), total: pickStats(records.map(r => r.serverTotalMs)) },
      clientDoneMs: pickStats(records.map(r => r.clientDoneMs)) }));
  }
} finally {
  await new Promise(resolve => { loopbackServer.close(resolve); loopbackServer.closeAllConnections(); });
}
clearInterval(sampler); sampleRss();
const finiteMax = name => Math.max(...scenarios.flatMap(s => s.samples.map(r => r[name]).filter(Number.isFinite)));
const result = {
  schemaVersion: 'qa-m0-runtime-baseline-v1', measuredAt: new Date().toISOString(), sourceSha,
  environment: { node: process.version, platform: process.platform, arch: process.arch, limits,
    network: 'no external network; service fetch forbidden; isolated native fetch allowed only to benchmark-owned 127.0.0.1 ephemeral HTTP server; container --network none', model: 'deterministic native tool-call/stream adapter; no artificial sleep and no provider call',
    database: 'synthetic in-memory persistence callbacks, not PostgreSQL or Supabase', transport: 'harness scenarios use in-memory response; http_loopback scenarios use actual HTTP/SSE over loopback; no product auth/browser/proxy/TLS' },
  path: ['handleWorkspaceStream', 'createDocumentRunContext', 'runWorkspaceAgent', 'createArtifactProtocol', 'createArtifactWorkspace', 'createArtifactLoader', 'createSseWriter'],
  fixture: { paragraphs: paragraphs.length, sourceUtf8Bytes: bytes(sourceText), manifestUtf8Bytes: bytes(packed.manifestText), artifactPartCount: partFiles.size,
    artifactTotalUtf8Bytes: bytes(packed.manifestText) + [...partFiles.values()].reduce((n, text) => n + bytes(text), 0), revision: artifact.revision,
    preparedBeforeTiming: true },
  measurement: { clock: 'performance.now monotonic', firstDelta: 'harness: first nonempty answer delta written by actual SSE writer, including admission waiting; http_loopback: client receives first nonempty answer delta',
    total: 'harness: submission to completed stream persistence/error cleanup; http_loopback: fetch start through done and body EOF, with server timings separately recorded', percentiles: 'nearest-rank, warmups excluded where stated',
    sourceCache: 'actual loader hits/misses and estimated resident bytes; actual backing-store UTF-8 loads; not network/disk throughput',
    rss: 'sampled RSS per SSE write plus 1ms sampler; process maxRSS and cgroup peak include preparation and all scenarios in this single process',
    syntheticTokenUsage: 'adapter supplies fixed illustrative tokens only to exercise usage persistence; never billable/token-cost measurements' },
  resources: { sampledPeakRssBytes, processMaxRssKiB: process.resourceUsage().maxRSS,
    cgroupMemoryPeakBytes: Number(await readMaybe(`${cgroupBase}/memory.peak`)) || null,
    cgroupMemoryEvents: await readMaybe(`${cgroupBase}/memory.events`), cpuStat: await readMaybe(`${cgroupBase}/cpu.stat`) },
  scenarios,
  hardAssertions: { allSatisfied: true, runtime: 'workspace-artifacts-v1', ordinaryModelCalls: 1, ordinaryToolCalls: 0,
    documentModelCalls: 2, documentToolCalls: 1, activeMaximum: 2, queueMaximum: 8,
    activeCancelCommits: 0, queuedCancelModelCalls: 0, allLeasesReleased: true },
  frozenComparisonPolicy: {
    applicability: 'same source fixture version, Node version, hard limits and synthetic adapter; compare median p95 from three fresh process runs; not production/provider SLA',
    timingRegression: { factor: 1.5, additiveNoiseFloorMs: 5, formula: 'candidate median p95 > baseline median p95 * 1.5 + 5ms requires investigation; also inspect p50 and raw sample counts' },
    rssRegression: { factor: 1.25, additiveNoiseFloorBytes: 33554432, formula: 'candidate processMaxRSS > baseline processMaxRSS * 1.25 + 32MiB requires investigation' },
    exactSemanticBudgets: { ordinaryModelCalls: 1, ordinaryToolCalls: 0, documentReadModelCalls: 2, documentReadToolCalls: 1,
      activeMaximum: 2, queuedMaximum: 8, activeCancelCommits: 0, queuedCancelModelCalls: 0, leakedLeases: 0 },
    cacheAndScanRegression: 'same fixture: cold backing-store bytes and scanChars must not increase; warm read must retain zero backing-store bytes; any increase needs explicit scope review',
  },
  initialRuntimeBudgets: { status: 'freeze current implemented budgets; no runtime/config change', modelCallsPerRun: 12, toolsPerRun: 24,
    activeRuns: 2, queuedRuns: 8, queueWaitMs: 120000, streamDeadlineMs: 300000,
    artifactLoaderCacheBytes: 33554432, artifactLoaderCacheEntries: 256, artifactLoaderPending: 32,
    returnedCharsPerReadCall: 14000, returnedCharsPerRun: 96000, searchScanCharsPerCall: 128000, searchScanCharsPerRun: 1000000,
    documentsPerRun: 8, newResourceOrAuxiliaryBudget: 'not measured by this benchmark; define separately before enabling',
    observedMaxReturnedChars: finiteMax('returnedChars'), observedMaxScanChars: finiteMax('scanChars') },
  limitations: ['Harness and isolated loopback transport overhead only. No real model/provider latency or title costs.', 'Synthetic persistence does not measure real database query plans or network round trips.',
    'One 90-paragraph fixture cannot establish worst-case whole-library capacity.', 'Cold means fresh application loader cache, not cold OS page cache.',
    'One process and no proxy/browser; multi-process aggregate admission is outside scope.', 'Benchmark never enables new M1 capabilities.'],
};
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceSha, limits, scenarioCount: scenarios.length, measuredRequests: scenarios.reduce((n, s) => n + s.sampleCount, 0),
  processMaxRssKiB: result.resources.processMaxRssKiB, scenarios: scenarios.map(s => ({ name: s.name, firstDeltaP95Ms: s.metrics.firstDeltaMs.p95, totalP95Ms: s.metrics.totalMs.p95 })) }));
