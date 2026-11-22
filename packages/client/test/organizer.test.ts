// El cliente guarda el token de organizador y crea un cuarto con room_create por MCP.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const PORT = 8300 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "agentroom-org-"));
const HOME = join(TMP, "home");
const BUNDLE = "packages/client/dist/agentroom.mjs";
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

const cli = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, ...args], { env: { ...process.env, AGENTROOM_HOME: HOME }, encoding: "utf8" });

test("organizer guarda el token con permisos de solo tu usuario", () => {
  const r = cli("organizer", "--base", BASE, "--token", "test-organizer");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(join(HOME, "organizer.json")).mode & 0o777, 0o600);
});

test("create devuelve un link por invitado", () => {
  const r = cli("create", "Cena de Ana", "ana", "beto");
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.invites.map((i: any) => i.name), ["ana", "beto"]);
  assert.ok(out.invites[1].link.startsWith(`${BASE}/rooms/`));
});

test("room_create por MCP crea el cuarto", async () => {
  const mcp = spawn(process.execPath, [BUNDLE, "mcp"], { env: { ...process.env, AGENTROOM_HOME: HOME }, stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: mcp.stdout! });
  const next = () => new Promise<any>((res) => lines.once("line", (l) => res(JSON.parse(l))));
  mcp.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_create", arguments: { name: "Viernes", invites: ["ana", "beto"] } } }) + "\n");
  const reply = await next();
  mcp.kill();
  const out = JSON.parse(reply.result.content[0].text);
  assert.equal(reply.result.isError, undefined);
  assert.equal(out.invites.length, 2);
});
