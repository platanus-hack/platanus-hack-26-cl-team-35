// Avisos a personas: adaptador Slack/Kapso con fetch falso y cola con reintentos.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DB_PATH = ":memory:";
const { createNotifier, enqueue, processPending, safe, swallow } = await import("../src/core/notify.ts");
const { db } = await import("../src/db.ts");

type Call = { url: string; init: any };
const fake = (reply: (c: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: any) => { const c = { url, init }; calls.push(c); return reply(c); }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
};
const ok = (b: unknown = { ok: true }) => new Response(JSON.stringify(b), { status: 200 });
const rows = () => db.prepare("SELECT case_id, person_id, payload, attempts, status, last_error FROM core_notifications ORDER BY id").all() as any[];
const reset = () => db.exec("DELETE FROM core_notifications");

test("slack: URL, header y cuerpo exactos", async () => {
  const f = fake(() => ok());
  const n = createNotifier({ fetch: f.fetch, env: { SLACK_BOT_TOKEN: "xoxb-secreto" } });
  assert.deepEqual(await n.send({ channel: "slack", address: "C123", text: "hola" }), { status: "sent" });
  assert.equal(f.calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.headers.authorization, "Bearer xoxb-secreto");
  assert.match(f.calls[0].init.headers["content-type"], /application\/json/);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { channel: "C123", text: "hola" });
});

test("slack: ok:false y http de error son fallo, sin filtrar el token", async () => {
  const a = createNotifier({ fetch: fake(() => ok({ ok: false, error: "channel_not_found" })).fetch, env: { SLACK_BOT_TOKEN: "xoxb-secreto" } });
  assert.deepEqual(await a.send({ channel: "slack", address: "C1", text: "x" }), { status: "failed", error: "slack: channel_not_found" });
  const b = createNotifier({ fetch: fake(() => new Response("no", { status: 500 })).fetch, env: { SLACK_BOT_TOKEN: "xoxb-secreto" } });
  assert.deepEqual(await b.send({ channel: "slack", address: "C1", text: "x" }), { status: "failed", error: "slack: http 500" });
  const c = createNotifier({ fetch: (async () => { throw new Error("boom xoxb-secreto"); }) as any, env: { SLACK_BOT_TOKEN: "xoxb-secreto" } });
  const r = await c.send({ channel: "slack", address: "C1", text: "x" });
  assert.equal(r.status, "failed");
  assert.ok(!JSON.stringify(r).includes("xoxb-secreto"));
});

test("canal sin variables de entorno queda skipped y no llama a fetch", async () => {
  const f = fake(() => ok());
  const n = createNotifier({ fetch: f.fetch, env: {} });
  assert.equal((await n.send({ channel: "slack", address: "C1", text: "x" })).status, "skipped");
  assert.equal((await n.send({ channel: "whatsapp", address: "5215512345678", text: "x" })).status, "skipped");
  assert.equal(createNotifier({ fetch: f.fetch, env: { KAPSO_API_KEY: "k" } }).send({ channel: "whatsapp", address: "1", text: "x" }) instanceof Promise, true);
  assert.equal(f.calls.length, 0);
});

test("kapso whatsapp: endpoint, X-API-Key y cuerpo de la documentación", async () => {
  const f = fake(() => ok({ messages: [{ id: "wamid" }] }));
  const n = createNotifier({ fetch: f.fetch, env: { KAPSO_API_KEY: "kk-secreto", KAPSO_PHONE_NUMBER_ID: "647015955153740" } });
  assert.deepEqual(await n.send({ channel: "whatsapp", address: "5215512345678", text: "hola" }), { status: "sent" });
  assert.equal(f.calls[0].url, "https://api.kapso.ai/meta/whatsapp/v24.0/647015955153740/messages");
  assert.equal(f.calls[0].init.headers["X-API-Key"], "kk-secreto");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { messaging_product: "whatsapp", to: "5215512345678", type: "text", text: { body: "hola" } });
  const bad = createNotifier({ fetch: fake(() => new Response("{}", { status: 401 })).fetch, env: { KAPSO_API_KEY: "kk-secreto", KAPSO_PHONE_NUMBER_ID: "1" } });
  assert.deepEqual(await bad.send({ channel: "whatsapp", address: "1", text: "x" }), { status: "failed", error: "kapso: http 401" });
});

test("cola: enviado en el primer intento", async () => {
  reset();
  const f = fake(() => ok());
  const n = createNotifier({ fetch: f.fetch, env: { SLACK_BOT_TOKEN: "t" } });
  await enqueue(n, "c1", "ana", { channel: "slack", address: "C1", text: "uno" });
  assert.deepEqual(rows().map((r) => [r.status, r.attempts, r.last_error]), [["sent", 1, null]]);
  await processPending(n, "c1");
  assert.equal(f.calls.length, 1);
});

test("cola: falla, reintenta en cada llamada y a los 3 intentos queda failed con last_error", async () => {
  reset();
  const f = fake(() => ok({ ok: false, error: "x".repeat(500) }));
  const n = createNotifier({ fetch: f.fetch, env: { SLACK_BOT_TOKEN: "t" } });
  await enqueue(n, "c2", "ana", { channel: "slack", address: "C1", text: "dos" });
  assert.deepEqual(rows().map((r) => [r.status, r.attempts]), [["pending", 1]]);
  await processPending(n, "otro-caso");
  assert.equal(f.calls.length, 1);
  await processPending(n, "c2");
  await processPending(n, "c2");
  await processPending(n, "c2");
  assert.equal(f.calls.length, 3);
  const r = rows()[0];
  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 3);
  assert.ok(r.last_error.length <= 200 && r.last_error.startsWith("slack: "));
});

test("cola: un reintento exitoso cierra el aviso y fetch que lanza no rompe", async () => {
  reset();
  let n1 = 0;
  const f = fake(() => { if (n1++ === 0) throw new Error("red"); return ok(); });
  const n = createNotifier({ fetch: f.fetch, env: { SLACK_BOT_TOKEN: "t" } });
  await enqueue(n, "c3", "ana", { channel: "slack", address: "C1", text: "tres" });
  assert.equal(rows()[0].status, "pending");
  await processPending(n, "c3");
  assert.deepEqual([rows()[0].status, rows()[0].attempts], ["sent", 2]);
});

test("cola: sin variables el aviso queda skipped", async () => {
  reset();
  const n = createNotifier({ fetch: fake(() => ok()).fetch, env: {} });
  await enqueue(n, "c4", "ana", { channel: "whatsapp", address: "52155", text: "cuatro" });
  assert.deepEqual(rows().map((r) => [r.status, r.last_error]), [["skipped", "whatsapp: canal apagado"]]);
});

test("timeout: un fetch colgado termina failed pronto", async () => {
  // AbortSignal.timeout no mantiene vivo el event loop; un fetch real sí (el socket), así que lo imitamos.
  const hang = ((_u: string, init: any) => new Promise((_, rej) => {
    const alive = setTimeout(() => {}, 5000);
    init.signal.addEventListener("abort", () => { clearTimeout(alive); rej(new Error("abort")); });
  })) as any;
  const n = createNotifier({ fetch: hang, env: { SLACK_BOT_TOKEN: "t" }, timeoutMs: 50 });
  const t0 = Date.now();
  assert.deepEqual(await n.send({ channel: "slack", address: "C1", text: "x" }), { status: "failed", error: "slack: error de red" });
  assert.ok(Date.now() - t0 < 2000);
});

test("concurrencia: dos processPending a la vez envían una sola vez", async () => {
  reset();
  let calls = 0;
  const slow = (async () => { calls++; await new Promise((r) => setTimeout(r, 100)); return ok(); }) as any;
  const n = createNotifier({ fetch: slow, env: { SLACK_BOT_TOKEN: "t" } });
  db.prepare("INSERT INTO core_notifications (case_id, person_id, payload) VALUES ('c5','ana',?)").run(JSON.stringify({ channel: "slack", address: "C1", text: "cinco" }));
  await Promise.all([processPending(n, "c5"), processPending(n, "c5")]);
  assert.equal(calls, 1);
  assert.deepEqual([rows()[0].status, rows()[0].attempts], ["sent", 1]);
});

test("concurrencia: una fila que otro proceso ya tomó no se vuelve a enviar", async () => {
  reset();
  let calls = 0;
  const slow = (async () => { calls++; await new Promise((r) => setTimeout(r, 100)); return ok(); }) as any;
  const n = createNotifier({ fetch: slow, env: { SLACK_BOT_TOKEN: "t" } });
  const ins = db.prepare("INSERT INTO core_notifications (case_id, person_id, payload) VALUES ('c7','ana',?)");
  ins.run(JSON.stringify({ channel: "slack", address: "C1", text: "uno" }));
  ins.run(JSON.stringify({ channel: "slack", address: "C1", text: "dos" }));
  // A lee las dos filas y se queda enviando la primera; B entra después y toma la segunda.
  const a = processPending(n, "c7");
  await new Promise((r) => setTimeout(r, 20));
  const b = processPending(n, "c7");
  await Promise.all([a, b]);
  assert.equal(calls, 2);
  assert.deepEqual(rows().map((r) => [r.status, r.attempts]), [["sent", 1], ["sent", 1]]);
});

test("un sending viejo (caída) se recupera; uno reciente no se toca", async () => {
  reset();
  const f = fake(() => ok());
  const n = createNotifier({ fetch: f.fetch, env: { SLACK_BOT_TOKEN: "t" } });
  const ins = db.prepare("INSERT INTO core_notifications (case_id, person_id, payload, status, claimed_at) VALUES ('c6','ana',?, 'sending', ?)");
  const payload = JSON.stringify({ channel: "slack", address: "C1", text: "seis" });
  ins.run(payload, Date.now() - 120_000);
  ins.run(payload, Date.now());
  await processPending(n, "c6");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(rows().map((r) => r.status), ["sent", "sending"]);
});

test("safe deja solo caracteres inertes y corta a 64", () => {
  assert.equal(safe("<!channel> <https://evil|x>"), "__channel___https:__evil_x_");
  assert.equal(safe("a".repeat(100)).length, 64);
  assert.equal(safe("camion-07@2026-11-24T08:00"), "camion-07@2026-11-24T08:00");
  assert.equal(safe("evil.com"), "evil_com");
});

test("swallow no propaga errores", async () => {
  await swallow("x", Promise.reject(new Error("boom")));
});
