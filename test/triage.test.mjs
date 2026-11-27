// Запуск: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { parseModelOutput } from "../triage.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };

// Поднимаем настоящий сервер с выданным имитатором на свободном порту.
async function withServer(fn, options = {}) {
  const server = createApp({ log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/triage`;
  try {
    await fn(async (body) => {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const send = (text) => JSON.stringify({ text });

test("корректная заявка возвращает тему и черновик", async () => {
  await withServer(async (post) => {
    const { status, body } = await post(send("Когда будет доставка заказа?"));
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.ok(body.draft.trim().length > 0);
  });
});

test("неверный ввод даёт 400 invalid_input", async () => {
  await withServer(async (post) => {
    for (const raw of [send(""), send("   "), JSON.stringify({}), JSON.stringify({ text: 42 }), "{broken", "null", "[]"]) {
      const { status, body } = await post(raw);
      assert.equal(status, 400, `тело ${raw}`);
      assert.deepEqual(body, { status: "invalid_input" });
    }
  });
});

test("сбои модели уходят на ручной разбор без черновика", async () => {
  await withServer(async (post) => {
    for (const mark of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
      const { status, body } = await post(send(`Вопрос по доставке ${mark}`));
      assert.equal(status, 200, mark);
      assert.deepEqual(body, MANUAL, mark);
    }
  });
});

test("модель не ответила за 300 мс: ручной разбор, ответ не ждёт 1,2 с имитатора", async () => {
  await withServer(async (post) => {
    const started = Date.now();
    const { status, body } = await post(send("Сколько стоит доставка? [timeout]"));
    assert.equal(status, 200);
    assert.deepEqual(body, MANUAL);
    assert.ok(Date.now() - started < 1000, "ответ должен прийти раньше, чем имитатор досчитает 1,2 с");
  });
});

test("модель, которая не слушает отмену, тоже обрывается по таймауту", async () => {
  const stubborn = () => new Promise((resolve) => setTimeout(() => resolve('{"topic":"other","draft":"поздно"}'), 2000).unref());
  await withServer(async (post) => {
    const { body } = await post(send("Любая заявка"));
    assert.deepEqual(body, MANUAL);
  }, { classify: stubborn, timeoutMs: 50 });
});

test("проверка ответа модели", () => {
  assert.deepEqual(parseModelOutput('{"topic":"pricing","draft":"Спасибо"}'), { topic: "pricing", draft: "Спасибо" });
  assert.equal(parseModelOutput('{"topic":"refund","draft":"Спасибо"}'), null);
  assert.equal(parseModelOutput('{"topic":"other","draft":"  "}'), null);
  assert.equal(parseModelOutput('{"topic":"other"}'), null);
  assert.equal(parseModelOutput("not json"), null);
  assert.equal(parseModelOutput("null"), null);
});
