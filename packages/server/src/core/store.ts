// Persistencia del core por replay: cada entrada que el motor acepta se guarda con su `now`
// y el motor de un caso se reconstruye reaplicándolas en orden.
import { createEngine } from "@agent-board/core";
import type { Registry } from "@agent-board/core";
import { db } from "../db.ts";

db.exec(`
  CREATE TABLE IF NOT EXISTS core_cases (id TEXT PRIMARY KEY, registry TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS core_tokens (token TEXT PRIMARY KEY, case_id TEXT NOT NULL, principal_id TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS core_inputs (
    case_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, now TEXT NOT NULL,
    PRIMARY KEY (case_id, seq)
  );
`);

export type Engine = ReturnType<typeof createEngine>;
/** event, read, decision y revoke son entradas del motor; ack marca entregas del inbox como entregadas. */
export type InputKind = "event" | "read" | "decision" | "revoke" | "ack";

const engines = new Map<string, Engine>(); // ponytail: sin expulsión, un motor vivo por caso; acotar si hay muchos casos

export const getRegistry = (caseId: string): Registry | undefined => {
  const row = db.prepare("SELECT registry FROM core_cases WHERE id = ?").get(caseId) as { registry: string } | undefined;
  return row && JSON.parse(row.registry);
};

export function createCase(caseId: string, registry: Registry, now: string) {
  db.prepare("INSERT INTO core_cases (id, registry, created_at) VALUES (?,?,?)").run(caseId, JSON.stringify(registry), now);
}

/** Reaplica una entrada guardada. Las que el motor aceptó antes se aceptan igual: es determinista. */
function reapply(engine: Engine, kind: InputKind, body: any, now: string): { ok: boolean; reason?: string } {
  if (kind === "event") return engine.apply(body, now);
  if (kind === "read") return engine.readEvidence(body, now);
  if (kind === "decision") return engine.decide(body, now);
  if (kind === "revoke") return engine.revoke(body.agent_id, body.at);
  for (const d of engine.outbox()) if (body.delivery_ids.includes(d.delivery_id)) d.status = "delivered";
  return { ok: true };
}

export function engineFor(caseId: string): Engine | undefined {
  let e = engines.get(caseId);
  if (e) return e;
  const registry = getRegistry(caseId);
  if (!registry) return undefined;
  e = createEngine(registry);
  const rows = db.prepare("SELECT seq, kind, body, now FROM core_inputs WHERE case_id = ? ORDER BY seq").all(caseId) as { seq: number; kind: InputKind; body: string; now: string }[];
  for (const r of rows) {
    const res = reapply(e, r.kind, JSON.parse(r.body), r.now);
    if (!res.ok) throw new Error(`replay falló en el caso ${caseId}, seq ${r.seq} (${r.kind}): ${(res as any).reason}`);
  }
  engines.set(caseId, e);
  return e;
}

export function saveInput(caseId: string, kind: InputKind, body: unknown, now: string) {
  db.prepare("INSERT INTO core_inputs (case_id, seq, kind, body, now) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM core_inputs WHERE case_id = ?), ?, ?, ?)")
    .run(caseId, caseId, kind, JSON.stringify(body), now);
}

export const isRevoked = (caseId: string, agentId: string): boolean =>
  (db.prepare("SELECT body FROM core_inputs WHERE case_id = ? AND kind = 'revoke'").all(caseId) as { body: string }[]).some((r) => JSON.parse(r.body).agent_id === agentId);
