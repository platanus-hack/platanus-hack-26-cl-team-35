import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, Event, TRANSITIONS, CONTRACT_VERSION, STATES, FINAL_STATES, KINDS } from "../src/contract.ts";
import { registry, events, expected, referenceTrace } from "../src/scenario.ts";

const byKind = (k: string) => events.find((e) => e.kind === k)!;

test("constantes del contrato", () => {
  assert.equal(CONTRACT_VERSION, "core-0.1");
  assert.equal(KINDS.length, 11);
  assert.ok(FINAL_STATES.every((s) => STATES.includes(s)));
});

test("el registro y cada evento del escenario pasan sus esquemas", () => {
  assert.ok(Registry.safeParse(registry).success);
  for (const e of events) assert.ok(Event.safeParse(e).success, e.event_id);
});

test("accept sin approver_id falla", () => {
  const { approver_id, ...payload } = byKind("accept").payload as any;
  assert.equal(Event.safeParse({ ...byKind("accept"), payload }).success, false);
});

test("deliver sin evidencia falla", () => {
  assert.equal(Event.safeParse({ ...byKind("deliver"), payload: { evidence: [] } }).success, false);
  assert.equal(Event.safeParse({ ...byKind("deliver"), payload: {} }).success, false);
});

test("campo extra falla (strictObject)", () => {
  assert.equal(Event.safeParse({ ...byKind("offer"), extra: 1 }).success, false);
  assert.equal(Event.safeParse({ ...byKind("offer"), payload: { x: 1 } }).success, false);
});

test("source_event_id obligatorio salvo en request", () => {
  const { source_event_id, ...sinSource } = byKind("offer") as any;
  assert.equal(Event.safeParse(sinSource).success, false);
  assert.equal("source_event_id" in byKind("request"), false);
  assert.equal(Event.safeParse({ ...byKind("request"), source_event_id: "e0" }).success, false);
});

test("note de mas de 280 falla", () => {
  assert.equal(Event.safeParse({ ...byKind("offer"), note: "x".repeat(281) }).success, false);
});

test("referenceTrace: un paso por evento y termina en verified", () => {
  assert.equal(referenceTrace.length, events.length);
  assert.equal(referenceTrace.at(-1)!.state_after, expected.final_state);
  assert.equal(expected.rejections, 0);
});

test("las transiciones de la tabla forman el camino del escenario", () => {
  let state: string | null = null;
  for (const [i, e] of events.entries()) {
    const t = TRANSITIONS[e.kind];
    if (state !== null) assert.ok((t.from as string[]).includes(state), `${e.kind} desde ${state}`);
    state = t.to ?? state;
    assert.equal(referenceTrace[i].state_after, state);
  }
});
