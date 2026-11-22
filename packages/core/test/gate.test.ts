import { test } from "node:test";
import assert from "node:assert/strict";
import { check, type Ctx } from "../src/gate.ts";
import { CONTRACT_VERSION, type Commitment, type Event } from "../src/contract.ts";
import { decisionFor, decisions, registry, events, referenceTrace } from "../src/scenario.ts";

const ev = (id: string) => events.find((e) => e.event_id === id)!;
const NOW = "2026-11-21T11:00:00Z";
const C = "almacen.coordinador";
const R = "transportes.rutas";

const commit = (over: Partial<Commitment> = {}): Commitment => ({
  case_id: "case-lt-1", task_id: "task-envio-lote-1", resource_id: "camion-07@2026-11-24T08:00",
  requester_id: C, provider_id: R, state: "offered", current_offer_event_id: "e2", receipts: [], ...over,
});
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  registry, commitment: commit(), caseLog: events, usedDecisionIds: new Set(), decisions: new Map(decisions.map((d) => [d.decision_id, d])), resourceHolders: new Map(), ...over,
});
const reg = (f: (r: typeof registry) => typeof registry) => f(structuredClone(registry));
const rule = (e: Event, c: Ctx, now = NOW) => {
  const d = check(e, c, now);
  assert.equal(d.allow, false);
  return d.allow ? null : d.rule;
};
const acceptWith = (p: object) => ({ ...ev("e3"), payload: { ...(ev("e3").payload as object), ...p } }) as Event;

test("contract_version", () => {
  assert.equal(rule({ ...ev("e3"), contract_version: "x" }, ctx()), "contract_version");
});
test("expired", () => {
  assert.equal(rule({ ...ev("e3"), expires_at: NOW }, ctx()), "expired");
  assert.equal(check({ ...ev("e3"), expires_at: "2026-11-21T11:00:01Z" }, ctx(), NOW).allow, true);
});
test("sender_registered", () => {
  assert.equal(rule({ ...ev("e3"), sender_id: "fantasma" }, ctx()), "sender_registered");
});
test("sender_valid: fuera de ventana y revocado", () => {
  assert.equal(rule(ev("e3"), ctx(), "2027-01-01T00:00:00Z"), "sender_valid");
  assert.equal(rule(ev("e3"), ctx(), "2026-10-31T00:00:00Z"), "sender_valid");
  const revoked = reg((r) => { r.agents[0].revoked_at = "2026-11-21T10:59:00Z"; return r; });
  assert.equal(rule(ev("e3"), ctx({ registry: revoked })), "sender_valid");
});
test("recipient_registered: ausente o revocado", () => {
  assert.equal(rule({ ...ev("e3"), recipient_id: "fantasma" }, ctx()), "recipient_registered");
  const revoked = reg((r) => { r.agents[2].revoked_at = "2026-11-21T10:00:00Z"; return r; });
  assert.equal(rule(ev("e3"), ctx({ registry: revoked })), "recipient_registered");
});
test("capability", () => {
  assert.equal(rule({ ...ev("e2"), sender_id: "almacen.inventario", recipient_id: R }, ctx()), "capability");
});
test("party: accept por quien no es requester, offer por quien no es provider, receipt de org ajena", () => {
  const otro = reg((r) => {
    r.agents.push({ ...r.agents[0], agent_id: "otro.coord", org_id: "otra-org" });
    return r;
  });
  assert.equal(rule({ ...ev("e3"), sender_id: "otro.coord" }, ctx({ registry: otro })), "party");
  assert.equal(rule({ ...ev("e2"), sender_id: R, recipient_id: C, kind: "offer" }, ctx({ commitment: commit({ provider_id: "otro" }) })), "party");
  assert.equal(rule({ ...ev("e6"), sender_id: "otro.coord" }, ctx({ registry: otro, commitment: commit({ state: "delivered" }) })), "party");
});
test("transition: accept desde requested, request con compromiso, sin compromiso", () => {
  assert.equal(rule(ev("e3"), ctx({ commitment: commit({ state: "requested" }) })), "transition");
  assert.equal(rule(ev("e1"), ctx()), "transition");
  assert.equal(rule(ev("e2"), ctx({ commitment: undefined })), "transition");
});
test("source_event", () => {
  assert.equal(rule({ ...ev("e3"), source_event_id: "nope" }, ctx()), "source_event");
});
test("approval: cada causa", () => {
  const person = (f: (p: (typeof registry.people)[number]) => void) => reg((r) => { f(r.people[0]); return r; });
  assert.equal(rule(acceptWith({ approver_id: "nadie" }), ctx()), "approval");
  assert.equal(rule(ev("e3"), ctx({ registry: person((p) => { p.may_approve = false; }) })), "approval");
  assert.equal(rule(ev("e3"), ctx({ registry: person((p) => { p.org_id = "transportes-sur"; }) })), "approval");
  assert.equal(rule(acceptWith({ approver_id: C }), ctx({ registry: reg((r) => { r.people.push({ person_id: C, org_id: "almacen-norte", may_approve: true }); return r; }) })), "approval");
  const sc = (ev("e3").payload as any).scope;
  for (const bad of [{ case_id: "x" }, { task_id: "x" }, { resource_id: "x" }, { offer_event_id: "e9" }]) {
    assert.equal(rule(acceptWith({ scope: { ...sc, ...bad } }), ctx()), "approval");
  }
  assert.equal(rule(ev("e3"), ctx({ usedDecisionIds: new Set(["dec-1"]) })), "approval");
});
test("double_booking", () => {
  assert.equal(rule(ev("e3"), ctx({ resourceHolders: new Map([["transportes-sur|camion-07@2026-11-24T08:00", "otra-tarea"]]) })), "double_booking");
  assert.equal(check(ev("e3"), ctx({ resourceHolders: new Map([["transportes-sur|camion-07@2026-11-24T08:00", "task-envio-lote-1"]]) }), NOW).allow, true);
});
test("receipt_required", () => {
  const c = commit({ state: "delivered", delivered_event_id: "e5", receipts: [] });
  assert.equal(rule(ev("e7"), ctx({ commitment: c })), "receipt_required");
  assert.equal(rule(ev("e7"), ctx({ commitment: { ...c, receipts: ["otro"] } })), "receipt_required");
});
test("evidence_scope", () => {
  const otro = reg((r) => {
    r.agents.push({ ...r.agents[0], agent_id: "otro.lector", org_id: "otra-org", capabilities: ["read_evidence"] });
    return r;
  });
  const e = { ...ev("e6"), kind: "read_evidence", sender_id: "otro.lector" } as Event;
  assert.equal(rule(e, ctx({ registry: otro, commitment: commit({ state: "delivered" }) })), "evidence_scope");
});
test("rechazo trae rule_version y reason", () => {
  const d = check({ ...ev("e3"), contract_version: "x" }, ctx(), NOW);
  assert.ok(!d.allow && d.rule_version === "1" && d.reason.length > 0);
});

test("escenario completo pasa evento por evento", () => {
  let commitment: Commitment | undefined;
  const caseLog: Event[] = [];
  const used = new Set<string>();
  const holders = new Map<string, string>();
  for (const e of events) {
    const d = check(e, { registry, commitment, caseLog, usedDecisionIds: used, decisions: new Map(decisions.map((x) => [x.decision_id, x])), resourceHolders: holders }, "2026-11-21T11:00:00Z");
    assert.deepEqual(d, { allow: true }, e.event_id);
    caseLog.push(e);
    // aplicacion manual minima del evento (el motor real es la Task 3)
    const exp = referenceTrace.find((t) => t.event_id === e.event_id)!;
    if (e.kind === "request") commitment = { case_id: e.case_id, task_id: e.task_id, resource_id: e.resource_id, requester_id: e.sender_id, provider_id: e.recipient_id, state: "requested", receipts: [] };
    else commitment = { ...commitment!, state: exp.state_after };
    if (e.kind === "offer") commitment.current_offer_event_id = e.event_id;
    if (e.kind === "accept") { used.add(e.payload.decision_id); holders.set(e.resource_id, e.task_id); }
    if (e.kind === "deliver") commitment.delivered_event_id = e.event_id;
    if (e.kind === "receipt") commitment.receipts = [...commitment.receipts, e.source_event_id];
  }
  assert.equal(commitment!.state, "verified");
});

test("accept con case/task/recurso distinto al compromiso se rechaza (transition) y no evade double_booking", () => {
  const holders = new Map([["transportes-sur|camion-07@2026-11-24T08:00", "otra-tarea"]]);
  const sc = (ev("e3").payload as any).scope;
  const forged = { ...acceptWith({ scope: { ...sc, case_id: "case-x", resource_id: "camion-99" } }), case_id: "case-x", resource_id: "camion-99" } as Event;
  assert.equal(rule(forged, ctx({ resourceHolders: holders })), "transition");
  assert.equal(rule({ ...ev("e3"), task_id: "otra" }, ctx()), "transition");
  // con los datos correctos, double_booking sigue buscando por el recurso del compromiso
  assert.equal(rule(ev("e3"), ctx({ resourceHolders: holders })), "double_booking");
});
test("party: el destinatario debe ser la contraparte", () => {
  assert.equal(rule({ ...ev("e5"), recipient_id: "almacen.inventario" }, ctx({ commitment: commit({ state: "executing" }) })), "party");
  assert.equal(rule({ ...ev("e3"), recipient_id: "almacen.inventario" }, ctx()), "party");
  assert.equal(rule({ ...ev("e6"), recipient_id: "almacen.inventario" }, ctx({ commitment: commit({ state: "delivered" }) })), "party");
  assert.equal(rule({ ...ev("e6"), sender_id: R, recipient_id: R }, ctx({ commitment: commit({ state: "delivered" }) })), "party");
});
test("source_event: el proveedor no puede dar recibo de su propio deliver", () => {
  const c = commit({ state: "delivered", delivered_event_id: "e5" });
  assert.equal(rule({ ...ev("e6"), sender_id: R, recipient_id: C }, ctx({ commitment: c })), "source_event");
});
test("source_event: verify debe apuntar al deliver vigente", () => {
  const c = commit({ state: "delivered", delivered_event_id: "e5", receipts: ["e5"] });
  assert.equal(rule({ ...ev("e7"), source_event_id: "e2" }, ctx({ commitment: c })), "source_event");
});

test("approval: la decision citada debe existir, ser del aprobador, aprobar y cubrir el alcance", () => {
  const d0 = decisions[0];
  const withDec = (d?: object) => ctx({ decisions: new Map(d ? [["dec-1", { ...d0, ...d } as typeof d0]] : []) });
  assert.equal(rule(ev("e3"), withDec()), "approval");
  assert.equal(rule(ev("e3"), ctx({ decisions: new Map([["otra", d0]]) })), "approval");
  assert.equal(rule(ev("e3"), withDec({ person_id: "otra.persona" })), "approval");
  assert.equal(rule(ev("e3"), withDec({ approve: false })), "approval");
  for (const bad of [{ case_id: "x" }, { task_id: "x" }, { resource_id: "x" }, { offer_event_id: "e9" }]) assert.equal(rule(ev("e3"), withDec(bad)), "approval", JSON.stringify(bad));
  assert.equal(check(ev("e3"), withDec({ conditions: "solo en la mañana" }), NOW).allow, true);
  assert.deepEqual(decisionFor(ev("e3") as Extract<Event, { kind: "accept" }>).approve, true);
});

test("source_event: el evento origen debe ser de la misma tarea", () => {
  const otra = { ...ev("e5"), event_id: "o5", task_id: "task-otra" } as Event;
  const c = commit({ state: "accepted" });
  assert.equal(rule({ ...ev("e4"), source_event_id: "o5" }, ctx({ commitment: c, caseLog: [...events, otra] })), "source_event");
});
