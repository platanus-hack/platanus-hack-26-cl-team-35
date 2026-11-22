import { test } from "node:test";
import assert from "node:assert/strict";
import { ADVERSARIAL, invariants, replay, runAll, runCase, withDecisions } from "../src/harness.ts";
import { CONTRACT_VERSION } from "../src/contract.ts";
import { decisions, registry, events } from "../src/scenario.ts";

test("runAll: referencia y todos los casos adversariales salen ok", async () => {
  const report = await runAll();
  assert.equal(report.contract_version, CONTRACT_VERSION);
  assert.equal(report.reference.ok, true);
  assert.deepEqual(report.cases.filter((c) => !c.ok), []);
  const names = report.cases.map((c) => c.name);
  for (const n of ["double_booking", "duplicate_message", "expired_message", "revoked_agent", "cross_party_read", "failed_delivery", "instruction_in_evidence", "cited_authorization", "retry_after_revocation", "case_hijack", "self_deal", "fabricated_decision", "rejected_decision"])
    assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => n.startsWith("borrowed_approval")).length, 2);
});

test("replay usa created_at como now y la referencia no viola invariantes", () => {
  const r = replay(registry, withDecisions(events, decisions));
  assert.equal(r.rejections.length, 0);
  assert.equal(r.trace.at(-1)?.state_after, "verified");
  assert.deepEqual(invariants(r.engine, registry), []);
});

test("invariants detecta un log que el registro no autoriza", () => {
  const r = replay(registry, withDecisions(events, decisions));
  const revoked = { ...registry, agents: registry.agents.map((a) => (a.agent_id === "transportes.rutas" ? { ...a, revoked_at: "2026-11-21T10:00:30Z" } : a)) };
  assert.ok(invariants(r.engine, revoked).length > 0);
});

test("mutacion: sin revoked_at, retry_after_revocation reporta contraejemplo con contract_version", async () => {
  const c = ADVERSARIAL.find((x) => x.name === "retry_after_revocation")!;
  const registry2 = { ...c.registry, agents: c.registry.agents.map(({ revoked_at, ...a }) => a) };
  const r = await runCase({ ...c, registry: registry2 });
  assert.equal(r.ok, false);
  assert.equal(r.counterexample?.contract_version, CONTRACT_VERSION);
  assert.ok(r.counterexample?.event);
});

test("replay aplica la decision entre la oferta y el accept; sin ella el accept cae con approval", () => {
  const ok = replay(registry, withDecisions(events, decisions));
  assert.equal(ok.engine.decisions().length, 1);
  assert.deepEqual(ok.trace.map((t) => t.event_id), events.map((e) => e.event_id));
  const sin = replay(registry, events);
  assert.deepEqual(sin.trace.find((t) => t.event_id === "e3"), { event_id: "e3", kind: "accept", ok: false, rule: "approval" });
});

test("replay acepta revocaciones en su lugar", () => {
  const r = replay(registry, [events[0], { type: "revoke", agent_id: "transportes.rutas", at: "2026-11-21T10:00:30Z" }, events[1]]);
  assert.deepEqual(r.trace.map((t) => t.ok), [true, false]);
});
