import { createServer } from "node:http";
import { writeJson } from "../http/json.mjs";

/** The QA process owns only /api/qa/*; no library/translation workers run here. */
export function createQaServer({ authenticate, handleRoute, release, maxConcurrentStreams = 2 }) {
  let activeStreams = 0;
  const users = new Set();
  return createServer(async (request, response) => {
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
      if (streaming && (activeStreams >= maxConcurrentStreams || users.has(user.id))) {
        writeJson(response, 429, { error: { code: 'qa_busy', message: '问答服务正在处理请求，请稍后再试。' } });
        return;
      }
      if (streaming) { activeStreams++; users.add(user.id); }
      try { await handleRoute(request, response, url, user); }
      finally { if (streaming) { activeStreams--; users.delete(user.id); } }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeJson(response, error.statusCode ?? 503, {
        error: { code: error.code ?? "qa_unavailable", message: "QA request failed." },
      });
    }
  });
}
