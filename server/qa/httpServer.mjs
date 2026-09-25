import { createServer } from "node:http";
import { createStreamAdmission } from './streamAdmission.mjs';
import { writeJson } from "../http/json.mjs";

/** The QA process owns only /api/qa/*; no library/translation workers run here. */
export function createQaServer({ authenticate, handleRoute, release, maxConcurrentStreams = 2, maxQueuedStreams = 0, queueWaitMs = 120000 }) {
  const admission = createStreamAdmission({ maxActive: maxConcurrentStreams, maxQueued: maxQueuedStreams, waitMs: queueWaitMs });
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (!url.pathname.startsWith("/api/qa/")) {
        writeJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/qa/health") {
        writeJson(response, 200, { status: "ok", service: "pdf-reader-qa", ...release });
        return;
      }
      const user = await authenticate(request);
      const streaming = request.method === 'POST' && url.pathname === '/api/qa/stream';
      if (streaming && Number(request.headers['content-length'] ?? 0) > 65536) {
        writeJson(response, 413, { error: { code: 'qa_request_too_large', message: '提问内容过长。' } }); return;
      }
      const controller = new AbortController();
      const close = () => controller.abort();
      response.once('close', close);
      let lease;
      const queuedAt = Date.now();
      try {
        if (streaming) {
          lease = await admission.acquire(user.id, controller.signal);
          if (response.destroyed) return;
          response.setHeader('X-QA-Queue-Wait-Ms', String(Date.now() - queuedAt));
        }
        await handleRoute(request, response, url, user);
      } finally { lease?.release(); response.removeListener('close', close); }

    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.end();
        return;
      }
      writeJson(response, error.statusCode ?? 503, {
        error: { code: error.code ?? "qa_unavailable", message: error.code?.startsWith("qa_") ? error.message : "QA request failed." },
      });
    }
  });
  server.qaAdmission = admission;
  return server;
}
