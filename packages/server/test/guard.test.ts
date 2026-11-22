// Límites por IP: login, creación de cuartos y flujos SSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, loginPayload, signValue } from "@agent-board/protocol";

let nextPort = 7600 + Math.floor(Math.random() * 300);

/** Levanta un servidor con su propia base y devuelve su URL. */
async function start(env: Record<string, string | undefined>) {
  const port = nextPort++;
  const base = `http://localhost:${port}`;
  const tmp = mkdtempSync(join(tmpdir(), "agentrooms-guard-"));
  const { ADMIN_TOKEN: _drop, NODE_ENV: _env, ...inherited } = process.env;
  const child: ChildProcess = spawn(process.execPath, ["packages/server/src/index.ts"], {
    env: { ...inherited, PORT: String(port), DB_PATH: join(tmp, "g.db"), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) return { base, stop: () => child.kill() }; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("el servidor no arrancó");
}

const get = (base: string, path: string, token?: string) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (base: string, path: string, body: unknown, token?: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

/** Login firmado con una llave nueva. */
function login(base: string, headers: Record<string, string> = {}) {
  const k = generateKeys(), ts = new Date().toISOString(), name = "agente";
  return fetch(base + "/accounts/login", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ public_key: k.public_key, display_name: name, ts, sig: signValue(loginPayload(k.public_key, name, ts), k.private_key) }),
  });
}

test("el login número 11 en un minuto desde la misma IP da 429, y x-forwarded-for no lo salta", async () => {
  const s = await start({ ADMIN_TOKEN: "test-admin" });
  try {
    for (let i = 0; i < 10; i++) assert.equal((await login(s.base)).status, 200, `login ${i + 1}`);
    const r = await login(s.base);
    assert.equal(r.status, 429);
    assert.equal((await r.json() as any).error, "rate_limited");
    assert.equal((await login(s.base, { "x-forwarded-for": "9.9.9.9" })).status, 429);
  } finally { s.stop(); }
});

test("crear el cuarto número 11 en un minuto da 429; el admin no tiene límite", async () => {
  const s = await start({ ADMIN_TOKEN: "test-admin", OPEN_SIGNUP: "1" });
  try {
    const acct = await (await login(s.base)).json() as any;
    for (let i = 0; i < 10; i++) assert.equal((await post(s.base, "/rooms", { kind: "open", name: `c${i}` }, acct.account_token)).status, 201, `cuarto ${i + 1}`);
    const r = await post(s.base, "/rooms", { kind: "open", name: "c10" }, acct.account_token);
    assert.equal(r.status, 429);
    assert.equal((await r.json() as any).error, "rate_limited");
    assert.equal((await post(s.base, "/rooms", { kind: "open", name: "admin" }, "test-admin")).status, 201);
  } finally { s.stop(); }
});

test("un context de 4000 caracteres con emojis pasa el límite de body", async () => {
  const s = await start({ ADMIN_TOKEN: "test-admin", OPEN_SIGNUP: "1" });
  try {
    const acct = await (await login(s.base)).json() as any;
    assert.equal((await post(s.base, "/rooms", { kind: "open", name: "emoji", context: "😀".repeat(2000) }, acct.account_token)).status, 201);
  } finally { s.stop(); }
});

test("el flujo SSE número 11 desde la misma IP da 429 y se libera al cerrar uno", async () => {
  const s = await start({ ADMIN_TOKEN: "test-admin" });
  const open: AbortController[] = [];
  const stream = async () => {
    const ac = new AbortController();
    const r = await fetch(`${s.base}/rooms/${room}/events`, { signal: ac.signal });
    if (r.status === 200) { await r.body!.getReader().read(); open.push(ac); }
    return r.status;
  };
  let room = "";
  try {
    room = (await (await post(s.base, "/rooms", { kind: "open", name: "sse" }, "test-admin")).json() as any).room_id;
    for (let i = 0; i < 10; i++) assert.equal(await stream(), 200, `flujo ${i + 1}`);
    assert.equal(await stream(), 429);
    open.shift()!.abort();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(await stream(), 200);
  } finally { for (const ac of open) ac.abort(); s.stop(); }
});

