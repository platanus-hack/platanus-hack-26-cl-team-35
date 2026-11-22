import { test } from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.ts";
import { dispatch } from "../src/outbox.ts";
import { ap, registry, events } from "../src/scenario.ts";

const NOW = "2026-11-21T11:00:00Z";
const upToDeliver = () => {
  const eng = createEngine(registry);
  for (const e of events) {
    if (e.event_id === "e6") break;
    assert.equal(ap(eng, e, NOW).ok, true);
  }
  return eng;
};

test("transporte que falla dos veces y luego entrega", async () => {
  const eng = upToDeliver();
  const n = eng.outbox().length;
  const calls = new Map<string, number>();
  const transport = async (d: { delivery_id: string }) => {
    const c = (calls.get(d.delivery_id) ?? 0) + 1;
    calls.set(d.delivery_id, c);
    if (c <= 2) throw new Error("caido");
  };
  const opts = { maxAttempts: 3 };
  const s1 = await dispatch(eng, transport, NOW, opts);
  assert.deepEqual(s1, { delivered: 0, retried: n, failed: 0 });
  assert.ok(eng.outbox().every((d) => d.status === "pending" && d.attempts === 1));
  await dispatch(eng, transport, NOW, opts);
  assert.ok(eng.outbox().every((d) => d.status === "pending" && d.attempts === 2));
  const s3 = await dispatch(eng, transport, NOW, opts);
  assert.deepEqual(s3, { delivered: n, retried: 0, failed: 0 });
  assert.ok(eng.outbox().every((d) => d.status === "delivered" && d.attempts === 3));
  assert.equal(eng.outbox()[0].last_attempt_at, NOW);
});

test("siempre falla: failed, compromiso sigue delivered y verify se rechaza", async () => {
  const eng = upToDeliver();
  const n = eng.outbox().length;
  const transport = () => { throw new Error("caido"); };
  const sums = [];
  for (let i = 0; i < 4; i++) sums.push(await dispatch(eng, transport, NOW, { maxAttempts: 3 }));
  assert.deepEqual(sums[2], { delivered: 0, retried: 0, failed: n });
  assert.deepEqual(sums[3], { delivered: 0, retried: 0, failed: 0 });
  assert.ok(eng.outbox().every((d) => d.status === "failed" && d.attempts === 3));
  assert.equal(eng.state()[0].state, "delivered");
  const r = eng.apply(events.find((e) => e.event_id === "e7"), NOW);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.rule, "receipt_required");
});

test("entregado no es recibo y el transporte recibe copias", async () => {
  const eng = upToDeliver();
  await dispatch(eng, (_d, e) => { (e as { kind: string }).kind = "x"; }, NOW);
  assert.ok(eng.outbox().every((d) => d.status === "delivered"));
  assert.equal(eng.state()[0].state, "delivered");
  assert.equal(eng.log()[0].kind, "request");
});
