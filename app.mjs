import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify as mockClassify } from "./mock-ai.mjs";
import { parseInput, triage } from "./triage.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const MAX_BODY_BYTES = 1024 * 1024;
const TOO_LARGE = Symbol("too large");
const utf8 = new TextDecoder("utf-8", { fatal: true });

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Тело дочитываем до конца даже сверх лимита: если бросить чтение, соединение keep-alive
// зависнет и следующий запрос клиента будет ждать таймаута. Сверх лимита байты не храним.
async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) return TOO_LARGE;
  try {
    return utf8.decode(Buffer.concat(chunks));
  } catch {
    return null; // не UTF-8, значит и не JSON
  }
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
      if (raw === TOO_LARGE) return json(response, 413, { status: "too_large" });
      const text = raw === null ? null : parseInput(raw);
      if (text === null) return json(response, 400, { status: "invalid_input" });
      return json(response, 200, await triage(text, { classify, timeoutMs, log }));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}
