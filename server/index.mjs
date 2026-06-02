import { createServer } from "node:http";
import { config as loadDotenv } from "dotenv";
import { writeJson } from "./http/json.mjs";
import { handleHealth } from "./routes/health.mjs";
import { handleTranslateStream } from "./routes/translate.mjs";

loadDotenv({ path: ".env" });
loadDotenv({ path: ".env.local", override: true });

const port = Number(process.env.PORT ?? 8787);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  applyCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    handleHealth(response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/translate/stream") {
    await handleTranslateStream(request, response);
    return;
  }

  writeJson(response, 404, {
    error: {
      code: "not_found",
      message: "Route not found",
    },
  });
});

server.listen(port, () => {
  console.log(`API proxy listening on http://localhost:${port}`);
});

function applyCorsHeaders(request, response) {
  response.setHeader("Access-Control-Allow-Origin", request.headers.origin ?? "http://localhost:5173");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
