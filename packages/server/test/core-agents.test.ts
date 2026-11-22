// Dos agentes guionizados por HTTP con coreClient, guiados por su inbox, hasta verified.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreClient } from "../../core/src/client.ts";
import { events, registry } from "../../core/src/scenario.ts";

const PORT = 9100 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), "core-ag-")), "test.db");
const ADMIN = { authorization: "Bearer test-admin", "content-type": "application/json" };
let server: ChildProcess;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_TOKEN: "test-admin" }, stdio: "inherit" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await sleep(100);
  }
  throw new Error("el servidor no arrancó");
});
after(() => { server.kill(); });

const reg = { ...registry, agents: registry.agents.map((a) => ({ ...a, valid_from: "2000-01-01T00:00:00Z", valid_until: "2100-01-01T00:00:00Z" })) };
const COORD = "almacen.coordinador";
const RUTAS = "transportes.rutas";
const [REQ, OFFER, ACCEPT, START, DELIVER, RECEIPT, VERIFY] = events as any[];

async function mkCase(case_id: string) {
  const r: any = await fetch(`${BASE}/core/cases`, { method: "POST", headers: ADMIN, body: JSON.stringify({ case_id, registry: reg }) }).then((x) => x.json());
  const tok = Object.fromEntries(r.agents.map((a: any) => [a.agent_id, a]));
  const cli = (id: string) => coreClient({ baseUrl: BASE, caseId: case_id, token: tok[id].token });
  return { r, tok, coord: cli(COORD), rutas: cli(RUTAS), ana: r.people[0].token as string };
}
const ev = (case_id: string, base: any, over: any) => ({ ...base, case_id, payload: base.payload, ...over });

test("dos agentes por inbox llegan a verified; cada uno solo recibe lo suyo", async () => {
  const id = "ag-1";
  const k = await mkCase(id);
  const seen: Record<string, any[]> = { [COORD]: [], [RUTAS]: [] };
  const done = { v: false };

  const coordinator = async () => {
    await k.coord.send(ev(id, REQ, {}));
    while (!done.v) {
      for (const d of (await k.coord.inbox()).deliveries) {
        const e = d.event; seen[COORD].push(e);
        if (e.kind === "offer") {
          let dec: any; // espera la decisión de la persona en el estado
          while (!(dec = (await k.coord.state()).decisions.find((x: any) => x.offer_event_id === e.event_id && x.approve))) await sleep(30);
          await k.coord.send(ev(id, ACCEPT, { event_id: "c-accept", source_event_id: e.event_id, payload: { approver_id: dec.person_id, decision_id: dec.decision_id, scope: { case_id: id, task_id: e.task_id, resource_id: e.resource_id, offer_event_id: e.event_id } } }));
        }
        if (e.kind === "deliver") {
          await k.coord.send(ev(id, RECEIPT, { event_id: "c-receipt", source_event_id: e.event_id }));
          await k.coord.send(ev(id, VERIFY, { event_id: "c-verify", source_event_id: e.event_id }));
          done.v = true;
        }
      }
      await sleep(30);
    }
  };
  const provider = async () => {
    while (!done.v) {
      for (const d of (await k.rutas.inbox()).deliveries) {
        const e = d.event; seen[RUTAS].push(e);
        if (e.kind === "request") await k.rutas.send(ev(id, OFFER, { event_id: "p-offer", source_event_id: e.event_id }));
        if (e.kind === "accept") {
          await k.rutas.send(ev(id, START, { event_id: "p-start", source_event_id: e.event_id }));
          await k.rutas.send(ev(id, DELIVER, { event_id: "p-deliver", source_event_id: "p-start" }));
        }
      }
      await sleep(30);
    }
  };
  const person = async () => {
    const h = { authorization: `Bearer ${k.ana}`, "content-type": "application/json" };
    while (!done.v) {
      const st: any = await fetch(`${BASE}/core/cases/${id}/state`, { headers: h }).then((x) => x.json());
      const c = st.commitments[0];
      if (c?.state === "offered" && !st.decisions.length) {
        const r = await fetch(`${BASE}/core/cases/${id}/decisions`, { method: "POST", headers: h, body: JSON.stringify({ task_id: c.task_id, offer_event_id: c.current_offer_event_id, approve: true }) });
        assert.equal(r.status, 201);
      }
      await sleep(30);
    }
  };
  const t = setTimeout(() => { done.v = true; }, 15000); // corta los bucles si algo se atora
  try { await Promise.all([coordinator(), provider(), person()]); } finally { clearTimeout(t); }

  assert.equal((await k.coord.state()).commitments[0].state, "verified");
  assert.ok(seen[COORD].length && seen[RUTAS].length);
  assert.ok(seen[COORD].every((e) => e.recipient_id === COORD));
  assert.ok(seen[RUTAS].every((e) => e.recipient_id === RUTAS));
});

test("el proveedor no puede aceptar su propia oferta: llega el rechazo del motor", async () => {
  const id = "ag-2";
  const k = await mkCase(id);
  await k.coord.send(ev(id, REQ, {}));
  await k.rutas.send(ev(id, OFFER, {}));
  const bad = ev(id, ACCEPT, { sender_id: RUTAS, recipient_id: COORD });
  await assert.rejects(k.rutas.send(bad), (e: any) => e.status === 403 && ["capability", "party"].includes(e.body.error) && !!e.body.hint);
});

test("agent.md del caso: 200 con token de agente sin filtrar el token, 401 sin token", async () => {
  const k = await mkCase("ag-3");
  const url = k.tok[RUTAS].agent_md_url as string;
  const r = await fetch(`${url}?token=${k.tok[RUTAS].token}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/markdown/);
  const md = await r.text();
  assert.ok(md.includes(RUTAS) && md.includes("transportes-sur") && md.includes("$TOKEN"));
  assert.ok(!md.includes(k.tok[RUTAS].token));
  const b = await fetch(url, { headers: { authorization: `Bearer ${k.tok[RUTAS].token}` } });
  assert.equal(b.status, 200);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}?token=${k.ana}`)).status, 403);
});

test("revocar al proveedor a mitad de caso: su token deja de servir y el coordinador ya no le escribe", async () => {
  const id = "ag-4";
  const k = await mkCase(id);
  await k.coord.send(ev(id, REQ, {}));
  await k.rutas.send(ev(id, OFFER, {}));
  const rv = await fetch(`${BASE}/core/cases/${id}/revoke`, { method: "POST", headers: ADMIN, body: JSON.stringify({ agent_id: RUTAS }) });
  assert.equal(rv.status, 200);
  await assert.rejects(k.rutas.send(ev(id, START, { event_id: "p-start" })), (e: any) => e.status === 401);
  const next = ev(id, REQ, { event_id: "c-req2", task_id: "task-2", resource_id: "camion-08@2026-11-25T08:00" });
  await assert.rejects(k.coord.send(next), (e: any) => e.body.error === "recipient_registered");
});

test("agent.md da una guía por kind solo de las capacidades del agente", async () => {
  const k = await mkCase("ag-5");
  const hints = async (agent: string) => {
    const md = await fetch(`${k.tok[agent].agent_md_url}?token=${k.tok[agent].token}`).then((x) => x.text());
    return [...md.matchAll(/^- `(\w+)`: /gm)].map((m) => m[1]).sort();
  };
  assert.deepEqual(await hints(COORD), ["accept", "cancel", "read_evidence", "receipt", "reject", "request", "verify"]);
  assert.deepEqual(await hints(RUTAS), ["counteroffer", "deliver", "offer", "read_evidence", "receipt", "reject", "start"]);
  assert.deepEqual(await hints("almacen.inventario"), ["read_evidence", "receipt"]);
});
