// Vista para lentes con pantalla: HTML por cuarto y el renderer compartido de los chibis.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, loginPayload, signValue } from "@agent-board/protocol";

const TMP = mkdtempSync(join(tmpdir(), "agentrooms-glasses-"));
let server: ChildProcess, BASE = "";
before(async () => {
  const port = 10300 + Math.floor(Math.random() * 400);
  BASE = `http://localhost:${port}`;
  const { ADMIN_TOKEN: _a, NODE_ENV: _n, ...clean } = process.env;
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...clean, PORT: String(port), DB_PATH: join(TMP, "a.db"), OPEN_SIGNUP: "1" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
});
after(() => server?.kill());

test("GET /rooms/:id/glasses sirve la vista del cuarto, 404 si no existe", async () => {
  const k = generateKeys(), ts = new Date().toISOString();
  const post = async (p: string, b: unknown, t?: string) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) })).json() as any;
  const acct = await post("/accounts/login", { public_key: k.public_key, display_name: "Ana", ts, sig: signValue(loginPayload(k.public_key, "Ana", ts), k.private_key) });
  const room = await post("/rooms", { kind: "open", name: "Lentes" }, acct.account_token);
  const r = await fetch(`${BASE}/rooms/${room.room_id}/glasses`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(`"${room.room_id}"`) && !html.includes("__ROOM_ID__"));
  assert.equal((await fetch(`${BASE}/rooms/r_nope/glasses`)).status, 404);
});

test("GET /web/kubo3d.js sirve el módulo 3D compartido, y las dos vistas lo usan", async () => {
  const r = await fetch(`${BASE}/web/kubo3d.js`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /javascript/);
  assert.equal(await r.text(), readFileSync("packages/server/src/web/kubo3d.js", "utf8"));
  for (const f of ["view3d.html", "glasses.html"]) {
    const html = readFileSync(`packages/server/src/web/${f}`, "utf8");
    assert.ok(html.includes('from "/web/kubo3d.js"'), `${f} importa el módulo`);
    assert.ok(!/https?:\/\//.test(html.match(/<script type="importmap">[\s\S]*?<\/script>/)?.[0] ?? "x"), `${f}: three sale del server`);
  }
});

test("kubo3d.js: carga en Node y exporta lo que usan las vistas", async () => {
  const m = await import("../src/web/kubo3d.js");
  for (const k of ["seed", "loadKubo", "makeAgent", "play", "HAIR", "CLOTH"]) assert.ok(k in m, k);
  assert.equal(m.seed("r_x"), m.seed("r_x"));
  const ag = { state: "", actions: { idle: { reset() { return this; }, fadeIn() { return this; }, play() { return this; }, fadeOut() { return this; } } } };
  m.play(ag, "idle"); assert.equal(ag.state, "idle");
  m.play(ag, "nope"); assert.equal(ag.state, "idle", "una animación que no existe no cambia el estado");
});
