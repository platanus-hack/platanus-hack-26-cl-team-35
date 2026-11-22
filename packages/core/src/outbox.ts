// Reparto de la outbox: reintenta entregas pendientes. Entregar no es un recibo: el compromiso no cambia.
import type { Event } from "./contract.ts";
import type { Delivery, createEngine } from "./engine.ts";

export type Transport = (delivery: Delivery, event: Event) => void | Promise<void>;
export type DispatchSummary = { delivered: number; retried: number; failed: number };

export async function dispatch(
  engine: ReturnType<typeof createEngine>,
  transport: Transport,
  now: string,
  { maxAttempts = 3 }: { maxAttempts?: number } = {},
): Promise<DispatchSummary> {
  const summary = { delivered: 0, retried: 0, failed: 0 };
  const log = engine.log();
  for (const d of engine.outbox()) {
    if (d.status !== "pending") continue;
    const event = log.find((e) => e.event_id === d.event_id)!;
    d.attempts++;
    d.last_attempt_at = now;
    try {
      await transport(structuredClone(d), structuredClone(event));
      d.status = "delivered";
      summary.delivered++;
    } catch {
      if (d.attempts >= maxAttempts) { d.status = "failed"; summary.failed++; } else summary.retried++;
    }
  }
  return summary;
}
