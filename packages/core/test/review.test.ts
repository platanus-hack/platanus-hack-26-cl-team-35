// Regresiones de la revisión de la rama completa.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.ts";
import { check, type Ctx } from "../src/gate.ts";
import type { Event, Registry } from "../src/contract.ts";
import { ap, decisionFor, decisions, registry, events } from "../src/scenario.ts";

const NOW = "2026-11-21T11:00:00Z";
const V = { valid_from: "2026-11-01T00:00:00Z", valid_until: "2026-12-31T00:00:00Z" };
const ev = (id: string) => events.find((e) => e.event_id === id)!;
const withAgents = (...a: Registry["agents"]): Registry => ({ ...registry, agents: [...registry.agents, ...a] });
const run = (eng: ReturnType<typeof createEngine>, evs: Event[]) => evs.map((e) => (e.kind === "read_evidence" ? eng.readEvidence(e, NOW) : ap(eng, e, NOW)));
const upTo = (eng: ReturnType<typeof createEngine>, id: string) => { for (const e of events) { assert.equal(ap(eng, e, NOW).ok, true); if (e.event_id === id) break; } };
const INTRUSO = { agent_id: "intruso", provider: "x", org_id: "otra-org", role: "requester", capabilities: ["request" as const, "read_evidence" as const], ...V };
const ESTE = { agent_id: "este.rutas", provider: "x", org_id: "transportes-este", role: "provider", capabilities: ["offer" as const, "start" as const], ...V };

// Flujo request, offer, accept de otra tarea contra el proveedor dado.
const flow = (task: string, provider: string, decision: string, resource = ev("e1").resource_id): Event[] => {
  const b = { case_id: `case-${task}`, task_id: task, resource_id: resource, contract_version: "core-0.1", payload: {}, created_at: NOW };
  return [
    { ...b, event_id: `${task}-1`, kind: "request", sender_id: "almacen.coordinador", recipient_id: provider },
    { ...b, event_id: `${task}-2`, kind: "offer", sender_id: provider, recipient_id: "almacen.coordinador", source_event_id: `${task}-1` },
    { ...b, event_id: `${task}-3`, kind: "accept", sender_id: "almacen.coordinador", recipient_id: provider, source_event_id: `${task}-2`,
      payload: { approver_id: "ana.ops", decision_id: decision, scope: { case_id: b.case_id, task_id: task, resource_id: resource, offer_event_id: `${task}-2` } } },
  ] as Event[];
};

test("1: un tercero no entra a un caso existente con otra tarea", () => {
  const eng = createEngine(withAgents(INTRUSO));
  upTo(eng, "e5");
  const base = { ...ev("e1"), event_id: "x1", task_id: "task-x", sender_id: "intruso" };
  const r = ap(eng, base, NOW);
  assert.equal(r.ok === false && r.rule, "party");
  const rd = eng.readEvidence({ ...base, event_id: "x2", kind: "read_evidence", source_event_id: "x1", payload: {} } as Event, NOW);
  assert.equal(rd.ok, false);
});

test("1: gate, request a un case_id existente exige las mismas orgs", () => {
  const ctx: Ctx = { registry: withAgents(INTRUSO), caseLog: events, usedDecisionIds: new Set(), decisions: new Map(), resourceHolders: new Map() };
  const d = check({ ...ev("e1"), event_id: "x1", task_id: "task-x", sender_id: "intruso" }, ctx, NOW);
  assert.deepEqual(d.allow === false && d.rule, "party");
  // Mismas orgs en el mismo caso con otra tarea: pasa.
  assert.equal(check({ ...ev("e1"), event_id: "x2", task_id: "task-y" }, ctx, NOW).allow, true);
});

test("2: un read_evidence duplicado devuelve la instantánea original", () => {
  const reg = { ...registry, agents: registry.agents.map((a) => (a.agent_id === "almacen.inventario" ? { ...a, revoked_at: "2026-11-21T10:30:00Z" } : a)) };
  const eng = createEngine(reg);
  ap(eng, ev("e1"), "2026-11-21T10:00:00Z");
  const rd = { ...ev("e1"), event_id: "rd", kind: "read_evidence", sender_id: "almacen.inventario", recipient_id: "almacen.coordinador", source_event_id: "e1", payload: {} } as Event;
  const first = eng.readEvidence(rd, "2026-11-21T10:01:00Z");
  assert.deepEqual(first.ok && first.evidence, []);
  for (const e of events.slice(1, 5)) ap(eng, e, e.created_at);
  const again = eng.readEvidence(rd, NOW);
  assert.equal(again.ok && again.duplicate, true);
  assert.deepEqual(again.ok && again.evidence, []);
});

test("3: now inválido se rechaza con schema y no cambia nada", () => {
  const eng = createEngine(registry);
  const r = ap(eng, ev("e1"), "ayer");
  assert.equal(r.ok === false && r.rule, "schema");
  assert.deepEqual([eng.state(), eng.log(), eng.outbox()], [[], [], []]);
  const rd = eng.readEvidence({ ...ev("e1"), kind: "read_evidence", payload: {} } as Event, "ayer");
  assert.equal(rd.ok === false && rd.rule, "schema");
});

test("3: un registro inválido hace fallar createEngine", () => {
  const bad = { ...registry, agents: [{ ...registry.agents[0], valid_from: "ayer" }] };
  assert.throws(() => createEngine(bad));
});

test("4: no se puede pedir a uno mismo ni a la misma org ni a quien no ofrece", () => {
  const solo = { agent_id: "solo", provider: "x", org_id: "o", role: "r", capabilities: ["request" as const, "offer" as const], ...V };
  const mudo = { agent_id: "mudo", provider: "x", org_id: "o2", role: "r", capabilities: ["read_evidence" as const], ...V };
  const eng = createEngine(withAgents(solo, mudo));
  const q = (id: string, sender: string, recipient: string) => ap(eng, { ...ev("e1"), event_id: id, sender_id: sender, recipient_id: recipient }, NOW);
  for (const [s, r] of [["solo", "solo"], ["almacen.coordinador", "almacen.inventario"], ["almacen.coordinador", "mudo"]]) {
    const res = q(`q-${s}-${r}`, s, r);
    assert.equal(res.ok === false && res.rule, "party", `${s}->${r}`);
  }
  assert.deepEqual(eng.state(), []);
});

test("5: orgs proveedoras distintas con el mismo recurso no chocan, y el rechazo no filtra la tarea ajena", () => {
  const eng = createEngine(withAgents(ESTE));
  const rs = run(eng, [...flow("t-sur", "transportes.rutas", "d1"), ...flow("t-este", "este.rutas", "d2")]);
  assert.deepEqual(rs.map((r) => r.ok), Array(6).fill(true));
  const eng2 = createEngine(registry);
  const rs2 = run(eng2, [...flow("t-a", "transportes.rutas", "d1"), ...flow("t-b", "transportes.rutas", "d2")]);
  const last = rs2.at(-1)!;
  assert.equal(last.ok === false && last.rule, "double_booking");
  assert.ok(!(last.ok === false && last.reason.includes("t-a")));
});

test("6: contraoferta reemplaza la oferta vigente", () => {
  const eng = createEngine(registry);
  run(eng, events.slice(0, 2));
  assert.equal(ap(eng, { ...ev("e2"), event_id: "co", kind: "counteroffer", source_event_id: "e2" } as Event, NOW).ok, true);
  const acc = (id: string, source: string, offer: string, dec: string) => ({ ...ev("e3"), event_id: id, source_event_id: source, payload: { ...(ev("e3") as Extract<Event, { kind: "accept" }>).payload, decision_id: dec, scope: { ...(ev("e3") as Extract<Event, { kind: "accept" }>).payload.scope, offer_event_id: offer } } }) as Event;
  const old = ap(eng, acc("a-old", "co", "e2", "d1"), NOW);
  assert.equal(old.ok === false && old.rule, "approval");
  const oldSrc = ap(eng, acc("a-old2", "e2", "e2", "d1"), NOW);
  assert.equal(oldSrc.ok === false && oldSrc.rule, "source_event");
  assert.equal(ap(eng, acc("a-new", "co", "co", "d2"), NOW).ok, true);
});

test("6: una decisión tomada antes de la contraoferta no sirve para aceptar la oferta nueva", () => {
  const eng = createEngine(registry);
  run(eng, events.slice(0, 2));
  const accept = ev("e3") as Extract<Event, { kind: "accept" }>;
  assert.equal(eng.decide(decisionFor(accept, { decided_at: NOW }), NOW).ok, true);
  assert.equal(eng.apply({ ...ev("e2"), event_id: "co", kind: "counteroffer", source_event_id: "e2" } as Event, NOW).ok, true);
  const stale = eng.apply({ ...accept, source_event_id: "co" } as Event, NOW);
  assert.equal(stale.ok === false && stale.rule, "approval");
});

test("6: tras cancel o reject otra tarea puede aceptar el mismo recurso", () => {
  const after = (build: (eng: ReturnType<typeof createEngine>) => void) => {
    const eng = createEngine(registry);
    run(eng, flow("t-a", "transportes.rutas", "d1"));
    build(eng);
    return run(eng, flow("t-b", "transportes.rutas", "d2")).every((r) => r.ok);
  };
  const base = { contract_version: "core-0.1", payload: {}, created_at: NOW, case_id: "case-t-a", task_id: "t-a", resource_id: ev("e1").resource_id };
  const cancel = (id: string, src: string) => ({ ...base, event_id: id, kind: "cancel", sender_id: "almacen.coordinador", recipient_id: "transportes.rutas", source_event_id: src }) as Event;
  const reject = { ...base, event_id: "rj", kind: "reject", sender_id: "transportes.rutas", recipient_id: "almacen.coordinador", source_event_id: "t-a-3" } as Event;
  const start = { ...base, event_id: "st", kind: "start", sender_id: "transportes.rutas", recipient_id: "almacen.coordinador", source_event_id: "t-a-3" } as Event;
  assert.equal(after((e) => assert.equal(e.apply(cancel("c1", "t-a-3"), NOW).ok, true)), true);
  assert.equal(after((e) => assert.equal(e.apply(reject, NOW).ok, true)), true);
  assert.equal(after((e) => { e.apply(start, NOW); assert.equal(e.apply(cancel("c2", "st"), NOW).ok, true); }), true);
});

// Fronteras exactas del gate: los límites de vigencia y las reglas que ninguna otra cubre.
const gateCtx = (r: Registry = registry, caseLog: Event[] = events, state: "requested" | "offered" = "offered"): Ctx => ({
  registry: r, caseLog, usedDecisionIds: new Set(), decisions: new Map(decisions.map((d) => [d.decision_id, d])), resourceHolders: new Map(),
  commitment: { case_id: "case-lt-1", task_id: "task-envio-lote-1", resource_id: ev("e1").resource_id, requester_id: "almacen.coordinador", provider_id: "transportes.rutas", state, current_offer_event_id: state === "offered" ? "e2" : undefined, receipts: [] },
});
const ruleOf = (e: Event, c: Ctx) => { const d = check(e, c, NOW); return d.allow ? "allow" : d.rule; };
const patchCoord = (p: Partial<Registry["agents"][number]>): Registry => ({ ...registry, agents: registry.agents.map((a) => (a.agent_id === "almacen.coordinador" ? { ...a, ...p } : a)) });

test("sender_valid: now igual a valid_until ya está fuera de vigencia", () => {
  assert.equal(ruleOf(ev("e3"), gateCtx(patchCoord({ valid_until: NOW }))), "sender_valid");
});

test("sender_valid: now igual a revoked_at ya está revocado", () => {
  assert.equal(ruleOf(ev("e3"), gateCtx(patchCoord({ revoked_at: NOW }))), "sender_valid");
});

test("transition: un evento con otro resource_id del mismo caso y tarea se rechaza", () => {
  assert.equal(ruleOf({ ...ev("e3"), resource_id: "otro-recurso" }, gateCtx()), "transition");
});

test("party: un agente de una tercera org no puede hacer reject al requester", () => {
  const externa = { agent_id: "externa.agente", provider: "x", org_id: "externa", role: "provider", capabilities: ["reject" as const, "receipt" as const], ...V };
  const reject = { ...ev("e2"), event_id: "x-rj", kind: "reject", sender_id: "externa.agente", recipient_id: "almacen.coordinador", source_event_id: "e2" } as Event;
  assert.equal(ruleOf(reject, gateCtx(withAgents(externa))), "party");
});

test("source_event: un offer que cita un evento inexistente se rechaza", () => {
  const offer = { ...ev("e2"), event_id: "x-of", source_event_id: "no-existe" } as Event;
  assert.equal(ruleOf(offer, gateCtx(registry, [ev("e1")], "requested")), "source_event");
});

test("schema: now sin zona horaria se rechaza y no cambia nada", () => {
  const eng = createEngine(registry);
  const r = ap(eng, ev("e1"), "2026-11-21T10:00:00");
  assert.equal(r.ok === false && r.rule, "schema");
  assert.deepEqual([eng.state(), eng.log(), eng.outbox()], [[], [], []]);
});
