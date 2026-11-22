// Vista 3D del cuarto: HTML por cuarto y el modelo de KUBO servido por el propio server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeys, loginPayload, signValue } from "@agent-board/protocol";

const TMP = mkdtempSync(join(tmpdir(), "agentrooms-3d-"));
let server: ChildProcess, BASE = "";
before(async () => {
  const port = 9900 + Math.floor(Math.random() * 400);
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

test("GET /rooms/:id/view3d sirve la vista con el id del cuarto, 404 si no existe", async () => {
  const k = generateKeys(), ts = new Date().toISOString();
  const post = async (p: string, b: unknown, t?: string) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) })).json() as any;
  const acct = await post("/accounts/login", { public_key: k.public_key, display_name: "Ana", ts, sig: signValue(loginPayload(k.public_key, "Ana", ts), k.private_key) });
  const room = await post("/rooms", { kind: "open", name: "3D" }, acct.account_token);

  const r = await fetch(`${BASE}/rooms/${room.room_id}/view3d`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes(`"${room.room_id}"`));
  assert.ok(!html.includes("__ROOM_ID__"));
  assert.equal((await fetch(`${BASE}/rooms/r_nope/view3d`)).status, 404);
});

test("GET /assets/kubo.glb devuelve el modelo tal cual", async () => {
  const r = await fetch(`${BASE}/assets/kubo.glb`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "model/gltf-binary");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync("assets/kubo/kubo.glb"));
});

test("three.js sale del propio server: la vista no depende de internet", async () => {
  const html = readFileSync("packages/server/src/web/view3d.html", "utf8");
  assert.ok(!/https?:\/\//.test(html.slice(html.indexOf("importmap"))), "el importmap no apunta a un CDN");
  for (const f of ["build/three.module.js", "examples/jsm/loaders/GLTFLoader.js", "examples/jsm/utils/BufferGeometryUtils.js", "examples/jsm/utils/SkeletonUtils.js"]) {
    const r = await fetch(`${BASE}/vendor/three/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get("content-type") ?? "", /javascript/);
    await r.arrayBuffer();
  }
  // Solo esos archivos: nada más de node_modules.
  for (const f of ["package.json", "build/three.cjs", "..%2F..%2Fpackage.json", "examples/jsm/loaders/../../../package.json"]) {
    assert.equal((await fetch(`${BASE}/vendor/three/${f}`)).status, 404, f);
  }
});
