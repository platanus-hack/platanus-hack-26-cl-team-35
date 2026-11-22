// Token de organizador: solo puede crear cuartos. No arranca cuartos ni lee el admin.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8200 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "agentrooms-org-"));
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(TMP, "org.db"), ADMIN_TOKEN: "test-admin", ORGANIZER_TOKEN: "test-organizer" },
    stdio: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
});
after(() => { server.kill(); });

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

test("el organizador crea un cuarto con invitados por nombre", async () => {
  const r = await call("POST", "/rooms", "test-organizer", { name: "Cena de Ana", invites: ["ana", "beto"] });
  assert.equal(r.status, 201);
  const j = await r.json() as any;
  assert.deepEqual(j.invites.map((i: any) => i.label), ["ana", "beto"]);
  assert.ok(j.invites[0].url.includes(`/rooms/${j.room_id}/agent.md?invite=`));
});

test("el organizador no puede arrancar cuartos ni leer el admin", async () => {
  const created = await (await call("POST", "/rooms", "test-organizer", { name: "Otro", invites: ["ana", "beto"] })).json() as any;
  assert.equal((await call("POST", `/rooms/${created.room_id}/start`, "test-organizer")).status, 401);
  assert.equal((await call("GET", "/admin/requests", "test-organizer")).status, 401);
});

test("un token que no es de organizador ni de admin no crea cuartos", async () => {
  assert.equal((await call("POST", "/rooms", "tok-falso", { name: "x", invites: ["a", "b"] })).status, 401);
});

test("el admin sigue pudiendo crear cuartos", async () => {
  assert.equal((await call("POST", "/rooms", "test-admin", { name: "Admin", invites: ["a", "b"] })).status, 201);
});
