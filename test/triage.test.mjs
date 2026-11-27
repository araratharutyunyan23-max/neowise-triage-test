// Запуск: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.mjs";
import { MODEL_TIMEOUT_MS, parseModelOutput, triage } from "../triage.mjs";

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
    const elapsed = Date.now() - started;
    assert.equal(MODEL_TIMEOUT_MS, 300);
    assert.ok(elapsed >= 250 && elapsed < 700, `ответ за ${elapsed} мс, ждём около 300 мс, а не 1,2 с имитатора`);
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

test("граница 300 мс: быстрый ответ модели принимается, медленный уходит на ручной разбор", async () => {
  const answerAfter = (ms) => () => new Promise((resolve) => setTimeout(() => resolve('{"topic":"other","draft":"Готово"}'), ms));
  assert.equal((await triage("заявка", { classify: answerAfter(MODEL_TIMEOUT_MS - 150) })).status, "ready");
  assert.deepEqual(await triage("заявка", { classify: answerAfter(MODEL_TIMEOUT_MS + 150) }), MANUAL);
});

test("слишком большое тело: 413, а следующий запрос на том же соединении не зависает", async () => {
  await withServer(async (post) => {
    const big = await post(send("а".repeat(700_000)));
    assert.equal(big.status, 413);
    assert.deepEqual(big.body, { status: "too_large" });
    const started = Date.now();
    const next = await post(send("Когда будет доставка?"));
    assert.equal(next.body.status, "ready");
    assert.ok(Date.now() - started < 1000);
  });
});

test("тело не в UTF-8 считается неверным вводом", async () => {
  const server = createApp({ log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/triage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
