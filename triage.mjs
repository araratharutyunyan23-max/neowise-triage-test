// Разбор заявки: проверка ввода, вызов модели с ограничением по времени и проверка её ответа.
// Здесь нет HTTP, поэтому логику можно проверять тестами напрямую.

export const TOPICS = new Set(["delivery", "pricing", "other"]);
export const MODEL_TIMEOUT_MS = 300;

const MANUAL_REVIEW = Object.freeze({ status: "manual_review", topic: null, draft: null });

// Тело запроса: JSON-объект с непустой строкой text. Всё остальное считаем неверным вводом.
export function parseInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.text !== "string" || body.text.trim() === "") return null;
  return body.text;
}

// Ответ модели принимаем, только если это JSON с известной темой и непустым черновиком.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  if (!TOPICS.has(data.topic)) return null;
  if (typeof data.draft !== "string" || data.draft.trim() === "") return null;
  return { topic: data.topic, draft: data.draft };
}

// Ждём модель не дольше timeoutMs. Сигнал отменяет запрос к модели, а отдельный таймер
// защищает и от модели, которая сигнал не слушает.
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Итог для API: ready с темой и черновиком или manual_review, если модель не ответила вовремя,
// упала или вернула то, что нельзя показывать менеджеру как готовый черновик.
export async function triage(text, { classify, timeoutMs = MODEL_TIMEOUT_MS, log = () => {} } = {}) {
  let raw;
  try {
    raw = await callModel(classify, text, timeoutMs);
  } catch (error) {
    log("model_failed", error);
    return { ...MANUAL_REVIEW };
  }
  const result = parseModelOutput(raw);
  if (!result) {
    log("model_bad_output", raw);
    return { ...MANUAL_REVIEW };
  }
  return { status: "ready", ...result };
}
