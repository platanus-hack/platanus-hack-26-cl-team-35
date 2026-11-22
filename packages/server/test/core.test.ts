// Core de compromisos por HTTP: casos, tokens, eventos, inbox, revocación y replay tras reinicio.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { events, registry } from "../../core/src/scenario.ts";
import { CONTRACT_VERSION } from "../../core/src/contract.ts";

const PORT = 8900 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), "core-")), "test.db");
const ADMIN = { authorization: "Bearer test-admin", "content-type": "application/json" };
let server: ChildProcess;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function start() {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_TOKEN: "test-admin" }, stdio: "inherit" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await sleep(100);
  }
  throw new Error("el servidor no arrancó");
}
async function stop() {
  const done = new Promise((r) => server.once("exit", r));
  server.kill();
  await done;
}
before(start);
after(() => { server.kill(); });

const json = async (r: Response) => ({ status: r.status, ...(await r.json()) as any });
const get = (path: string, token?: string) => fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(json);
const post = (path: string, body: unknown, token?: string) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then(json);
const admin = (path: string, body: unknown) => fetch(BASE + path, { method: "POST", headers: ADMIN, body: JSON.stringify(body) }).then(json);

// Validez amplia para no depender de la fecha real del servidor.
const reg = { ...registry, agents: registry.agents.map((a) => ({ ...a, valid_from: "2000-01-01T00:00:00Z", valid_until: "2100-01-01T00:00:00Z" })) };
const COORD = "almacen.coordinador";
const RUTAS = "transportes.rutas";

/** Eventos del escenario con otro case_id. */
const evs = (case_id: string) => events.map((e) => {
  const x: any = { ...e, case_id };
  if (x.kind === "accept") x.payload = { ...x.payload, scope: { ...x.payload.scope, case_id } };
  return x;
});

async function mkCase(case_id: string) {
  const r = await admin("/core/cases", { case_id, registry: reg });
  assert.equal(r.status, 201, JSON.stringify(r));
  const tok = Object.fromEntries(r.agents.map((a: any) => [a.agent_id, a.token]));
  return { r, coord: tok[COORD] as string, rutas: tok[RUTAS] as string, ana: r.people[0].token as string, evs: evs(case_id) };
}

test("crear caso exige admin y registro válido", async () => {
  assert.equal((await post("/core/cases", { registry: reg })).status, 401);
  assert.equal((await admin("/core/cases", { registry: { agents: 1 } })).status, 400);
  const k = await mkCase("c-crear");
  assert.equal(k.r.agents.length, 3);
  assert.match(k.coord, /^ct_/);
  assert.equal(k.r.people[0].person_id, "ana.ops");
  assert.equal((await admin("/core/cases", { case_id: "c-crear", registry: reg })).status, 409);
});

test("eventos hasta offered, y accept sin decisión se rechaza con approval", async () => {
  const k = await mkCase("c-flujo");
  const [e1, e2, e3] = k.evs;
  const r1 = await post("/core/cases/c-flujo/events", e1, k.coord);
  assert.equal(r1.status, 201);
  assert.equal(r1.commitment.state, "requested");
  const r2 = await post("/core/cases/c-flujo/events", e2, k.rutas);
  assert.equal(r2.commitment.state, "offered");
  const dup = await post("/core/cases/c-flujo/events", e2, k.rutas);
  assert.equal(dup.status, 201);
  assert.equal(dup.duplicate, true);
  const bad = await post("/core/cases/c-flujo/events", e3, k.coord);
  assert.equal(bad.status, 403);
  assert.equal(bad.error, "approval");
  assert.equal(bad.rule_version, "1");
  assert.ok(bad.hint);
  const st = await get("/core/cases/c-flujo/state", k.ana);
  assert.equal(st.commitments[0].state, "offered");
  assert.equal(st.commitments[0].current_offer.event_id, "e2");
  assert.deepEqual(st.decisions, []);
});

test("rechazo de transición responde 409 y no cambia estado", async () => {
  const k = await mkCase("c-409");
  await post("/core/cases/c-409/events", k.evs[0], k.coord);
  const r = await post("/core/cases/c-409/events", k.evs[3], k.rutas); // start sin accept
  assert.equal(r.status, 409);
  assert.equal(r.error, "transition");
});

test("sender_mismatch, case_mismatch, token de otro caso y tipo de token", async () => {
  const a = await mkCase("c-a");
  const b = await mkCase("c-b");
  const sm = await post("/core/cases/c-a/events", a.evs[0], a.rutas); // e1 dice sender coordinador
  assert.equal(sm.status, 403);
  assert.equal(sm.error, "sender_mismatch");
  const cm = await post("/core/cases/c-a/events", { ...a.evs[0], case_id: "c-b" }, a.coord);
  assert.equal(cm.status, 400);
  assert.equal(cm.error, "case_mismatch");
  assert.equal((await post("/core/cases/c-a/events", a.evs[0], b.coord)).status, 401);
  assert.equal((await post("/core/cases/c-a/events", a.evs[0])).status, 401);
  assert.equal((await post("/core/cases/c-a/events", a.evs[0], a.ana)).status, 403); // persona en ruta de agente
  assert.equal((await get("/core/cases/c-a/state", b.ana)).status, 401);
  assert.equal((await get(`/core/cases/c-a/state?token=${a.coord}`)).status, 200);
});

test("evidencia: lectura por HTTP y rechazo si no hay capacidad", async () => {
  const k = await mkCase("c-ev");
  const re = (sender: string, id: string) => ({ ...k.evs[0], event_id: id, kind: "read_evidence", sender_id: sender, recipient_id: sender, source_event_id: "e1", payload: {} });
  await post("/core/cases/c-ev/events", k.evs[0], k.coord);
  const ok = await post("/core/cases/c-ev/evidence", re(COORD, "r1"), k.coord);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.evidence, []);
  const no = await post("/core/cases/c-ev/evidence", { ...re(RUTAS, "r2"), recipient_id: "fantasma" }, k.rutas);
  assert.equal(no.status, 403);
  assert.equal(no.error, "recipient_registered");
});

test("inbox entrega pendientes, las marca y el replay lo conserva", async () => {
  const k = await mkCase("c-inbox");
  await post("/core/cases/c-inbox/events", k.evs[0], k.coord);
  const i1 = await get("/core/cases/c-inbox/inbox", k.rutas);
  assert.equal(i1.deliveries.length, 1);
  assert.equal(i1.deliveries[0].event.event_id, "e1");
  assert.equal((await get("/core/cases/c-inbox/inbox", k.rutas)).deliveries.length, 0);
  assert.equal((await get("/core/cases/c-inbox/inbox", k.coord)).deliveries.length, 0);
  await stop(); await start();
  assert.equal((await get("/core/cases/c-inbox/inbox", k.rutas)).deliveries.length, 0);
  await post("/core/cases/c-inbox/events", k.evs[1], k.rutas);
  assert.equal((await get("/core/cases/c-inbox/inbox", k.coord)).deliveries.length, 1);
});

test("revocar: el token del agente deja de servir y no se rotan tokens de un revocado", async () => {
  const k = await mkCase("c-rev");
  await post("/core/cases/c-rev/events", k.evs[0], k.coord);
  assert.equal((await admin("/core/cases/c-rev/revoke", { agent_id: "nadie" })).status, 404);
  assert.equal((await post("/core/cases/c-rev/revoke", { agent_id: RUTAS }, k.coord)).status, 401);
  assert.equal((await admin("/core/cases/c-rev/revoke", { agent_id: RUTAS })).status, 200);
  assert.equal((await post("/core/cases/c-rev/events", k.evs[1], k.rutas)).status, 401);
  // un token nuevo para un revocado no existe: rotación 409
  assert.equal((await admin("/core/cases/c-rev/tokens", { agent_id: RUTAS })).status, 409);
});

test("rotación: token nuevo sirve, el viejo da 401", async () => {
  const k = await mkCase("c-rot");
  const n = await admin("/core/cases/c-rot/tokens", { agent_id: COORD });
  assert.equal(n.status, 201);
  assert.notEqual(n.token, k.coord);
  assert.equal((await post("/core/cases/c-rot/events", k.evs[0], k.coord)).status, 401);
  assert.equal((await post("/core/cases/c-rot/events", k.evs[0], n.token)).status, 201);
  assert.equal((await admin("/core/cases/c-rot/tokens", { agent_id: "nadie" })).status, 404);
});

test("reinicio: el estado, las decisiones y la revocación salen idénticos por replay", async () => {
  const k = await mkCase("c-restart");
  await post("/core/cases/c-restart/events", k.evs[0], k.coord);
  await post("/core/cases/c-restart/events", k.evs[1], k.rutas);
  await admin("/core/cases/c-restart/revoke", { agent_id: "almacen.inventario" });
  const kr = await mkCase("c-restart-rev");
  await admin("/core/cases/c-restart-rev/revoke", { agent_id: RUTAS });
  const dec = await post("/core/cases/c-restart/decisions", { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true }, k.ana);
  assert.equal(dec.status, 201);
  const ev0 = await post("/core/cases/c-restart/evidence", { ...k.evs[0], event_id: "read-1", kind: "read_evidence", payload: {} }, k.coord);
  const before = await get("/core/cases/c-restart/state", k.ana);
  await stop(); await start();
  const after = await get("/core/cases/c-restart/state", k.ana);
  delete before.status; delete after.status;
  assert.deepEqual(after, before);
  // la revocación sobrevivió: una solicitud dirigida a RUTAS falla recipient_registered
  const toRutas = await post("/core/cases/c-restart-rev/events", kr.evs[0], kr.coord);
  assert.equal(toRutas.error, "recipient_registered");
  assert.match(toRutas.hint, /revoc/i);
  // el motor reconstruido sigue aplicando reglas: e1 otra vez es duplicado, no error
  assert.equal((await post("/core/cases/c-restart/events", k.evs[0], k.coord)).duplicate, true);
  // la decisión sobrevivió: una segunda sobre la misma oferta se rechaza
  assert.equal((await post("/core/cases/c-restart/decisions", { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true }, k.ana)).status, 403);
  // la lectura de evidencia sobrevivió: repetirla devuelve lo mismo
  assert.deepEqual(await post("/core/cases/c-restart/evidence", { ...k.evs[0], event_id: "read-1", kind: "read_evidence", payload: {} }, k.coord), ev0);
});

const form = (path: string, fields: Record<string, string>) =>
  fetch(BASE + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

test("case_id inválido es 400 y un caso inexistente responde igual que uno existente sin token", async () => {
  assert.equal((await admin("/core/cases", { case_id: "mal id/../x", registry: reg })).status, 400);
  await mkCase("c-oraculo");
  const a = await post("/core/cases/c-oraculo/events", {}, "ct_falso");
  const b = await post("/core/cases/no-existe/events", {}, "ct_falso");
  assert.equal(a.status, 401);
  assert.deepEqual(b, a);
  assert.equal((await get("/core/cases/no-existe/state")).status, 401);
});

test("vista: 401 sin token, 403 con token de agente, 200 con la oferta vigente y sin evidencia", async () => {
  const k = await mkCase("c-vista");
  assert.equal((await fetch(`${BASE}/core/cases/c-vista/view`)).status, 401);
  assert.equal((await fetch(`${BASE}/core/cases/c-vista/view?token=${k.coord}`)).status, 403);
  await post("/core/cases/c-vista/events", k.evs[0], k.coord);
  await post("/core/cases/c-vista/events", k.evs[1], k.rutas);
  const r = await fetch(`${BASE}/core/cases/c-vista/view?token=${k.ana}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  const html = await r.text();
  for (const s of ["e2", RUTAS, "camion-07@2026-11-24T08:00", "task-envio-lote-1", "offered", "Aprobar", "Rechazar"]) assert.ok(html.includes(s), s);
});

test("decisiones: solo persona del caso, cuerpo estricto, y el accept que la cita llega a accepted", async () => {
  const k = await mkCase("c-dec");
  await post("/core/cases/c-dec/events", k.evs[0], k.coord);
  await post("/core/cases/c-dec/events", k.evs[1], k.rutas);
  const body = { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true };
  assert.equal((await post("/core/cases/c-dec/decisions", body)).status, 401);
  assert.equal((await post("/core/cases/c-dec/decisions", body, k.coord)).status, 403);
  assert.equal((await post("/core/cases/c-dec/decisions", { ...body, person_id: "otro" }, k.ana)).status, 400);
  assert.equal((await post("/core/cases/c-dec/decisions", { ...body, decision_id: "dec-1" }, k.ana)).status, 400);
  assert.equal((await post("/core/cases/c-dec/decisions", { ...body, task_id: "nada" }, k.ana)).status, 404);
  assert.equal((await post("/core/cases/c-dec/decisions", { ...body, offer_event_id: "e1" }, k.ana)).error, "approval");
  const bogus = { ...k.evs[2], payload: { ...k.evs[2].payload, decision_id: "dec_inventado" } };
  assert.equal((await post("/core/cases/c-dec/events", bogus, k.coord)).error, "approval");
  const d = await post("/core/cases/c-dec/decisions", body, k.ana);
  assert.equal(d.status, 201);
  assert.match(d.decision.decision_id, /^dec_/);
  assert.equal(d.decision.person_id, "ana.ops");
  assert.equal(d.decision.resource_id, "camion-07@2026-11-24T08:00");
  const acc = { ...k.evs[2], payload: { ...k.evs[2].payload, decision_id: d.decision.decision_id } };
  const r = await post("/core/cases/c-dec/events", acc, k.coord);
  assert.equal(r.commitment.state, "accepted");
});

test("decisión de persona sin may_approve se rechaza", async () => {
  const r = await admin("/core/cases", { case_id: "c-sinperm", registry: { ...reg, people: [...reg.people, { person_id: "bob", org_id: "almacen-norte", may_approve: false }] } });
  const bob = r.people[1].token;
  const tok = Object.fromEntries(r.agents.map((a: any) => [a.agent_id, a.token]));
  const e = evs("c-sinperm");
  await post("/core/cases/c-sinperm/events", e[0], tok[COORD]);
  await post("/core/cases/c-sinperm/events", e[1], tok[RUTAS]);
  const d = await post("/core/cases/c-sinperm/decisions", { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true }, bob);
  assert.equal(d.status, 403);
  assert.equal(d.error, "approval");
  assert.ok(!(await fetch(`${BASE}/core/cases/c-sinperm/view?token=${bob}`).then((x) => x.text())).includes("<form"));
});

test("formulario: token en campo, 303 a la vista, conditions escapadas en el HTML", async () => {
  const k = await mkCase("c-form");
  await post("/core/cases/c-form/events", k.evs[0], k.coord);
  await post("/core/cases/c-form/events", k.evs[1], k.rutas);
  const evil = `<script>alert(1)</script>`;
  const r = await form("/core/cases/c-form/decisions", { token: k.ana, task_id: "task-envio-lote-1", offer_event_id: "e2", approve: "true", conditions: evil });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/core/cases/c-form/view?token=${k.ana}`);
  const html = await fetch(`${BASE}/core/cases/c-form/view?token=${k.ana}`).then((x) => x.text());
  assert.ok(!html.includes(evil));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<form")); // ya decidida
  assert.equal((await form("/core/cases/c-form/decisions", { task_id: "x", offer_event_id: "e2", approve: "true" })).status, 401);
});

test("e2e LogisticsTech por HTTP hasta verified con decisión de ana.ops", async () => {
  const k = await mkCase("c-e2e");
  const E = k.evs, P = "/core/cases/c-e2e/events";
  await post(P, E[0], k.coord);
  await post(P, E[1], k.rutas);
  const d = await post("/core/cases/c-e2e/decisions", { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true }, k.ana);
  const acc = { ...E[2], payload: { ...E[2].payload, decision_id: d.decision.decision_id } };
  assert.equal((await post(P, acc, k.coord)).commitment.state, "accepted");
  assert.equal((await post(P, E[3], k.rutas)).commitment.state, "executing");
  assert.equal((await post(P, E[4], k.rutas)).commitment.state, "delivered");
  assert.equal((await post(P, E[5], k.coord)).status, 201);
  assert.equal((await post(P, E[6], k.coord)).commitment.state, "verified");
  const html = await fetch(`${BASE}/core/cases/c-e2e/view?token=${k.ana}`).then((x) => x.text());
  assert.ok(html.includes("verified") && html.includes("evidence/guia-camion-07.pdf") && html.includes("a".repeat(64)));
  await stop(); await start();
  assert.equal((await get("/core/cases/c-e2e/state", k.ana)).commitments[0].state, "verified");
});

test("vista: cabeceras de seguridad, notas del proveedor escapadas, fieldset y maxlength", async () => {
  const k = await mkCase("c-hdr");
  await post("/core/cases/c-hdr/events", k.evs[0], k.coord);
  await post("/core/cases/c-hdr/events", { ...k.evs[1], note: "<b>urge</b>" }, k.rutas);
  const r = await fetch(`${BASE}/core/cases/c-hdr/view?token=${k.ana}`);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  const html = await r.text();
  assert.ok(html.includes("Notas del proveedor") && html.includes("&lt;b&gt;urge&lt;/b&gt;") && !html.includes("<b>urge</b>"));
  assert.match(html, /<fieldset>\s*<legend>[^<]*task-envio-lote-1/);
  assert.match(html, /name="conditions" maxlength="280"/);
});

test("token de persona de otro caso: 401 en vista y decisiones; decided_at en el cuerpo es 400", async () => {
  const a = await mkCase("c-x1");
  const b = await mkCase("c-x2");
  await post("/core/cases/c-x1/events", a.evs[0], a.coord);
  await post("/core/cases/c-x1/events", a.evs[1], a.rutas);
  const body = { task_id: "task-envio-lote-1", offer_event_id: "e2", approve: true };
  assert.equal((await fetch(`${BASE}/core/cases/c-x1/view?token=${b.ana}`)).status, 401);
  assert.equal((await post("/core/cases/c-x1/decisions", body, b.ana)).status, 401);
  assert.equal((await post("/core/cases/c-x1/decisions", { ...body, decided_at: "2020-01-01T00:00:00Z" }, a.ana)).status, 400);
});

test("avisos: la oferta encola un aviso skipped sin variables y el evento se acepta", async () => {
  const people = [{ ...reg.people[0], notify: { channel: "slack", address: "C123" } }];
  const r = await admin("/core/cases", { case_id: "c-aviso", registry: { ...reg, people } });
  assert.equal(r.status, 201, JSON.stringify(r));
  const tok = Object.fromEntries(r.agents.map((a: any) => [a.agent_id, a.token]));
  const e = evs("c-aviso");
  await post("/core/cases/c-aviso/events", e[0], tok[COORD]);
  assert.equal((await post("/core/cases/c-aviso/events", e[1], tok[RUTAS])).status, 201);
  assert.equal((await post("/core/cases/c-aviso/events", e[1], tok[RUTAS])).duplicate, true); // el duplicado no avisa
  const db = new DatabaseSync(DB);
  const rows = db.prepare("SELECT person_id, status, payload FROM core_notifications WHERE case_id = 'c-aviso'").all() as any[];
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].person_id, "ana.ops");
  assert.equal(rows[0].status, "skipped");
  const p = JSON.parse(rows[0].payload);
  assert.equal(p.channel, "slack");
  assert.ok(p.text.includes("task-envio-lote-1") && p.text.includes("camion-07@2026-11-24T08:00") && p.text.includes("/core/cases/c-aviso/view"));
  assert.ok(!p.text.includes(r.people[0].token) && !p.text.includes("token="));
});

test("avisos: resource_id hostil no inyecta menciones ni links en el texto", async () => {
  const people = [{ ...reg.people[0], notify: { channel: "slack", address: "C123" } }];
  const r = await admin("/core/cases", { case_id: "c-inyec", registry: { ...reg, people } });
  const tok = Object.fromEntries(r.agents.map((a: any) => [a.agent_id, a.token]));
  const evil = "<!channel> <https://evil|x>";
  const e = evs("c-inyec").map((x: any) => ({ ...x, resource_id: evil }));
  await post("/core/cases/c-inyec/events", e[0], tok[COORD]);
  assert.equal((await post("/core/cases/c-inyec/events", e[1], tok[RUTAS])).status, 201);
  const db = new DatabaseSync(DB);
  const row = db.prepare("SELECT payload FROM core_notifications WHERE case_id = 'c-inyec'").get() as any;
  db.close();
  const text = JSON.parse(row.payload).text;
  assert.ok(!/[<>|]/.test(text) && !text.includes("evil|x"), text);
});

test("registro con notify inválido se rechaza", async () => {
  const people = [{ ...reg.people[0], notify: { channel: "sms", address: "1" } }];
  assert.equal((await admin("/core/cases", { case_id: "c-notif-mal", registry: { ...reg, people } })).status, 400);
});

test("rotación de persona: el token viejo da 401 y el nuevo sirve en la vista", async () => {
  const k = await mkCase("c-rotp");
  const n = await admin("/core/cases/c-rotp/tokens", { person_id: "ana.ops" });
  assert.equal(n.status, 201);
  assert.equal(n.person_id, "ana.ops");
  assert.equal((await fetch(`${BASE}/core/cases/c-rotp/view?token=${k.ana}`)).status, 401);
  assert.equal((await fetch(`${BASE}/core/cases/c-rotp/view?token=${n.token}`)).status, 200);
  assert.equal((await admin("/core/cases/c-rotp/tokens", { person_id: "nadie" })).status, 404);
  assert.equal((await admin("/core/cases/c-rotp/tokens", { person_id: "ana.ops", agent_id: reg.agents[0].agent_id })).status, 400);
  assert.equal((await admin("/core/cases/c-rotp/tokens", {})).status, 400);
  // el token de agente sigue igual
  assert.equal((await post("/core/cases/c-rotp/events", k.evs[0], k.coord)).status, 201);
});

test("agent.md: contract_version real, participantes y sin tokens", async () => {
  const k = await mkCase("c-md");
  const md = await fetch(`${BASE}/core/cases/c-md/agent.md?token=${k.coord}`).then((x) => x.text());
  assert.ok(md.includes(`"contract_version": "${CONTRACT_VERSION}"`));
  assert.ok(md.includes(RUTAS));
  assert.ok(md.includes("transportes"));
  assert.ok(!md.includes(k.coord) && !md.includes(k.rutas));
  const ok = await post("/core/cases/c-md/events", { ...k.evs[0], contract_version: CONTRACT_VERSION }, k.coord);
  assert.equal(ok.status, 201);
  const bad = await post("/core/cases/c-md/events", { ...k.evs[0], event_id: "x9", contract_version: "1" }, k.coord);
  assert.match(bad.hint, new RegExp(CONTRACT_VERSION));
});

test("base URL: x-forwarded-proto https y PUBLIC_URL en agent_md_url", async () => {
  const r = await fetch(`${BASE}/core/cases`, { method: "POST", headers: { ...ADMIN, "x-forwarded-proto": "https" }, body: JSON.stringify({ case_id: "c-proto", registry: reg }) }).then(json);
  assert.match(r.agents[0].agent_md_url, /^https:\/\//);
  assert.match(r.people[0].view_url, /^https:\/\//);
  const md = await fetch(`${BASE}/core/cases/c-proto/agent.md?token=${r.agents[0].token}`, { headers: { "x-forwarded-proto": "https" } }).then((x) => x.text());
  assert.ok(md.includes("https://localhost"));
  const evil = await fetch(`${BASE}/core/cases`, { method: "POST", headers: { ...ADMIN, "x-forwarded-proto": "https://evil.test/?" }, body: JSON.stringify({ case_id: "c-proto-bad", registry: reg }) }).then(json);
  assert.match(evil.agents[0].agent_md_url, /^http:\/\/localhost/);
});

test("base URL: PUBLIC_URL manda sobre el host", async () => {
  await stop();
  const prev = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://core.ejemplo.test/";
  try { await start(); } finally { if (prev === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = prev; }
  const r = await admin("/core/cases", { case_id: "c-pub", registry: reg });
  assert.equal(r.agents[0].agent_md_url, "https://core.ejemplo.test/core/cases/c-pub/agent.md");
  assert.ok(r.people[0].view_url.startsWith("https://core.ejemplo.test/core/cases/c-pub/view"));
  await stop();
  await start();
});
