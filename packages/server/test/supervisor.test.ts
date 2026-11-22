// Límite de mensajes: los reintentos rechazados no alargan el bloqueo ni hacen crecer la lista.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRate } from "../src/supervisor.ts";

test("los reintentos rechazados no alargan el bloqueo", () => {
  const real = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    assert.deepEqual(checkRate("r", "p", 2), { ok: true, first: false });
    assert.deepEqual(checkRate("r", "p", 2), { ok: true, first: false });
    assert.deepEqual(checkRate("r", "p", 2), { ok: false, first: true });
    t += 30_000;
    for (let i = 0; i < 1000; i++) assert.deepEqual(checkRate("r", "p", 2), { ok: false, first: false });
    t += 30_001;
    assert.equal(checkRate("r", "p", 2).ok, true, "un minuto después del primer rechazo vuelve a pasar");
  } finally { Date.now = real; }
});
