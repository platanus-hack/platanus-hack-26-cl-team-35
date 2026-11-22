// Cuentas: el agente inicia sesión con su llave, el admin lo aprueba y desde ahí administra sus cuartos.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8400 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const TMP = mkdtempSync(join(tmpdir(), "agentroom-acct-"));
const BUNDLE = "packages/client/dist/agentroom.mjs";
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: join(TMP, "acct.db"), ADMIN_TOKEN: "test-admin" },
    stdio: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
});
after(() => { server.kill(); });

const MANDATE = (name: string) => ({ display_name: name, platform: "test", constraints: { budget_max_mxn: 500, days: [{ day: "sat" }], zones: ["any"], diet: [], needs_music: false }, may_volunteer: [] });
function agent(name: string) {
  const home = join(TMP, name);
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], { env: { ...process.env, AGENTROOM_HOME: home, AGENTROOM_ADMIN_TOKEN: "test-admin" }, encoding: "utf8" });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const file = join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify(MANDATE(name)));
  assert.equal(run("init", "--mandate", file).status, 0);
  return run;
}

const ana = agent("ana"), beto = agent("beto");
let roomId = "", betoLink = "";

test("la primera sesión queda pendiente y no puede crear cuartos", () => {
  const r = ana("login", "--base", BASE);
  assert.equal(r.status, 0);
  assert.equal(r.out.status, "pending");
  assert.equal(r.out.account_token, undefined, "el token no se muestra");
  const c = ana("create", "Comida", "ana", "beto");
  assert.equal(c.status, 1);
  assert.equal(c.err.error, "account_not_approved");
});

test("volver a iniciar sesión con la misma llave da la misma cuenta", () => {
  assert.equal(ana("login").out.account_id, ana("whoami").out.account_id);
});

test("el admin ve la cuenta pendiente y la aprueba", () => {
  const id = ana("whoami").out.account_id;
  const list = ana("accounts", "--base", BASE);
  assert.ok(list.out.accounts.some((a: any) => a.id === id && !("token" in a)));
  assert.equal(ana("approve", id, "--base", BASE).out.status, "approved");
  assert.equal(ana("whoami").out.can_create_rooms, true);
});

test("con la cuenta aprobada crea el cuarto y lo ve en su lista", () => {
  const c = ana("create", "Comida", "ana", "beto");
  assert.equal(c.status, 0, JSON.stringify(c.err));
  roomId = c.out.room_id;
  betoLink = c.out.invites[1].link;
  const rooms = ana("rooms").out.rooms;
  assert.equal(rooms[0].room_id, roomId);
  assert.equal(rooms[0].owner, true);
});

test("el dueño ve quién falta con su link, e invita a alguien más", () => {
  const m = ana("members", roomId).out.members;
  assert.equal(m.length, 2);
  assert.ok(m.every((x: any) => !x.joined && x.invite_url));
  const inv = ana("invite", roomId, "ana");
  assert.equal(inv.status, 0);
  assert.equal(inv.out.invites.length, 1);
  assert.equal(ana("members", roomId).out.members.length, 3, "un nombre repetido recibe su propio participante");
});

test("un invitado entra, ve a los miembros sin links y sale antes de que arranque", () => {
  assert.equal(beto("join", betoLink).status, 0);
  const m = beto("members").out.members;
  assert.ok(m.every((x: any) => !("invite_url" in x)));
  assert.ok(ana("members", roomId).out.members.find((x: any) => x.participant_id === "p_beto").joined);
  assert.equal(beto("leave").status, 0);
  assert.equal(ana("members", roomId).out.members.find((x: any) => x.participant_id === "p_beto").joined, false);
  assert.equal(beto("join", betoLink).status, 0, "la invitación queda libre para volver");
});

test("solo el dueño arranca el cuarto", async () => {
  beto("login", "--base", BASE);
  assert.equal(beto("start", roomId).err.error, "not_owner");
  const r = await fetch(`${BASE}/rooms/${roomId}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: new URL(ana("members", roomId).out.members[0].invite_url).searchParams.get("invite") }) });
  assert.equal(r.status, 200);
  const s = ana("start", roomId);
  assert.equal(s.status, 0, JSON.stringify(s.err));
  assert.equal(s.out.phase, "constraints");
  assert.equal(beto("leave").err.error, "room_started");
});

test("una firma con la hora vieja no inicia sesión", async () => {
  const r = await fetch(`${BASE}/accounts/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_key: "x", display_name: "x", ts: "2020-01-01T00:00:00Z", sig: "x" }) });
  assert.equal((await r.json() as any).error, "stale_login");
});
