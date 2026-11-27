import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";
import { parseInput, triage } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// classify и timeoutMs можно подменить в тестах; по умолчанию выданный имитатор и 300 мс.
export function createApp({ classify = mockClassify, timeoutMs, log = (event, detail) => console.warn(event, String(detail)) } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const raw = await readBody(request);
      const text = raw === null ? null : parseInput(raw);
      if (text === null) return json(response, 400, { status: "invalid_input" });
      return json(response, 200, await triage(text, { classify, timeoutMs, log }));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

// node server.mjs запускает сервер; при импорте из тестов он сам не стартует.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  createApp().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
