import assert from "node:assert/strict";
import { test } from "node:test";
import { once, EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createQaServer } from "../../server/qa/httpServer.mjs";

test("QA service authenticates QA requests and never dispatches app routes", async (t) => {
  const calls = [];
  const server = createQaServer({
    authenticate: async (request) => {
      if (request.headers.authorization !== "Bearer synthetic") throw Object.assign(new Error(), { statusCode: 401, code: "unauthorized" });
      return { id: "test-user" };
    },
    handleRoute: async (_request, response, url, user) => {
      calls.push({ path: url.pathname, user: user.id });
      response.end("QA response");
    },
    release: { version: "0.1.0-alpha.1", sha: "a".repeat(40) },
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/qa/health`)).json();
  assert.equal(health.service, "pdf-reader-qa");
  assert.equal(health.sha, "a".repeat(40));
  for (const path of ["/api/health", "/api/translate/stream", "/api/library/documents", "/api/mathpix/jobs"]) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/qa/threads`)).status, 401);
  assert.equal((await fetch(`${base}/api/qa/threads`, { headers: { authorization: "Bearer synthetic" } })).status, 200);
  assert.deepEqual(calls, [{ path: "/api/qa/threads", user: "test-user" }]);
});

test("the app boots and serves non-QA routes even with a broken, disabled QA module", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "qa-isolation-"));
  cpSync("server", join(temp, "server"), { recursive: true });
  cpSync("shared", join(temp, "shared"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(temp, "node_modules"), "dir");
  writeFileSync(join(temp, "server/routes/qa.mjs"), "throw new Error('synthetic broken QA import');\n");
  const child = spawn(process.execPath, [join(temp, "server/index.mjs")], {
    cwd: temp, env: { PATH: process.env.PATH, PORT: "0", QA_EMBEDDED_ENABLED: "false", SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_ANON_KEY: "synthetic-anon" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  t.after(async () => { child.kill(); await exited; rmSync(temp, { recursive: true, force: true }); });
  let output = "";
  const base = await new Promise((resolveBase, reject) => {
    const timer = setTimeout(() => reject(new Error(`App did not start: ${output}`)), 8000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`App exited: ${code} ${output}`)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timer); resolveBase(`http://127.0.0.1:${match[1]}`); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
  });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/qa/threads`)).status, 503);
  for (const path of ["/api/translate/stream", "/api/library/metadata", "/api/mathpix/jobs"]) {
    assert.equal((await fetch(base + path, { method: "POST" })).status, 401, path);
  }
});

test("standalone QA refuses implicit environment configuration", async () => {
  const child = spawn(process.execPath, [resolve("server/qa-service.mjs")], { env: { PATH: process.env.PATH } });
  let error = "";
  child.stderr.on("data", (chunk) => { error += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(error, /QA_ENV_FILE is required/);
});

test('QA stream concurrency is bounded and slots release on completion', async t => {
  const started = new EventEmitter(), releases = new Map();
  const server = createQaServer({ authenticate: async req => ({ id: req.headers.authorization }), release: {},
    handleRoute: async (_req, res, _url, user) => {
      await new Promise(resolve => { releases.set(user.id, resolve); started.emit('start'); });
      res.end('finished');
    } });
  t.after(() => { for (const resolve of releases.values()) resolve(); server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/qa/stream`;
  const send = user => fetch(url, { method: 'POST', headers: { authorization: user } });
  const aStarted = once(started, 'start'), a = send('a'); await aStarted;
  assert.equal((await send('a')).status, 429);
  const bStarted = once(started, 'start'), b = send('b'); await bStarted;
  assert.equal((await send('c')).status, 429);
  releases.get('a')(); assert.equal((await a).status, 200);
  const cStarted = once(started, 'start'), c = send('c'); await cStarted;
  releases.get('b')(); releases.get('c')();
  assert.equal((await b).status, 200); assert.equal((await c).status, 200);
});
