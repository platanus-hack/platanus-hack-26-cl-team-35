// Escenario de referencia LogisticsTech: la secuencia feliz que el core debe aceptar completa.
import { CONTRACT_VERSION, type Event, type HumanDecision, type Registry, type State } from "./contract.ts";

const valid = { valid_from: "2026-11-01T00:00:00Z", valid_until: "2026-12-31T00:00:00Z" };

export const registry: Registry = {
  agents: [
    { agent_id: "almacen.coordinador", provider: "agentroom", org_id: "almacen-norte", role: "requester", capabilities: ["request", "accept", "verify", "cancel", "reject", "receipt", "read_evidence"], ...valid },
    { agent_id: "almacen.inventario", provider: "agentroom", org_id: "almacen-norte", role: "observer", capabilities: ["read_evidence", "receipt"], ...valid },
    { agent_id: "transportes.rutas", provider: "agentroom", org_id: "transportes-sur", role: "provider", capabilities: ["offer", "counteroffer", "start", "deliver", "reject", "receipt", "read_evidence"], ...valid },
  ],
  people: [{ person_id: "ana.ops", org_id: "almacen-norte", may_approve: true }],
};

const COORD = "almacen.coordinador";
const RUTAS = "transportes.rutas";
const common = { case_id: "case-lt-1", task_id: "task-envio-lote-1", resource_id: "camion-07@2026-11-24T08:00", contract_version: CONTRACT_VERSION };
const at = (min: number) => new Date(Date.UTC(2026, 10, 21, 10, min)).toISOString().replace(".000", "");

export const events: Event[] = [
  { ...common, event_id: "e1", kind: "request", sender_id: COORD, recipient_id: RUTAS, created_at: at(0), payload: {} },
  { ...common, event_id: "e2", kind: "offer", sender_id: RUTAS, recipient_id: COORD, source_event_id: "e1", created_at: at(1), payload: {} },
  {
    ...common, event_id: "e3", kind: "accept", sender_id: COORD, recipient_id: RUTAS, source_event_id: "e2", created_at: at(2),
    payload: { approver_id: "ana.ops", decision_id: "dec-1", scope: { case_id: common.case_id, task_id: common.task_id, resource_id: common.resource_id, offer_event_id: "e2" } },
  },
  { ...common, event_id: "e4", kind: "start", sender_id: RUTAS, recipient_id: COORD, source_event_id: "e3", created_at: at(3), payload: {} },
  {
    ...common, event_id: "e5", kind: "deliver", sender_id: RUTAS, recipient_id: COORD, source_event_id: "e4", created_at: at(4),
    payload: { evidence: [{ ref: "evidence/guia-camion-07.pdf", sha256: "a".repeat(64) }] },
  },
  { ...common, event_id: "e6", kind: "receipt", sender_id: COORD, recipient_id: RUTAS, source_event_id: "e5", created_at: at(5), payload: {} },
  { ...common, event_id: "e7", kind: "verify", sender_id: COORD, recipient_id: RUTAS, source_event_id: "e5", created_at: at(6), payload: {} },
];

export const expected = { final_state: "verified" as State, rejections: 0 };

export const referenceTrace: { event_id: string; kind: Event["kind"]; state_after: State }[] = [
  ["e1", "request", "requested"],
  ["e2", "offer", "offered"],
  ["e3", "accept", "accepted"],
  ["e4", "start", "executing"],
  ["e5", "deliver", "delivered"],
  ["e6", "receipt", "delivered"],
  ["e7", "verify", "verified"],
].map(([event_id, kind, state_after]) => ({ event_id, kind, state_after }) as { event_id: string; kind: Event["kind"]; state_after: State });

/** Decisión humana que respalda un accept: misma persona y mismo alcance que cita el evento. */
export const decisionFor = (accept: Extract<Event, { kind: "accept" }>, over: Partial<HumanDecision> = {}): HumanDecision => ({
  decision_id: accept.payload.decision_id,
  person_id: accept.payload.approver_id,
  ...accept.payload.scope,
  approve: true,
  decided_at: accept.created_at,
  ...over,
});

/** ana.ops aprueba la oferta e2 entre la oferta (10:01) y el accept (10:02). */
export const decisions: HumanDecision[] = [decisionFor(events.find((e) => e.event_id === "e3") as Extract<Event, { kind: "accept" }>, { decided_at: "2026-11-21T10:01:30Z" })];

/**
 * Atajo de pruebas: antes de un accept registra la decisión que lo respalda, solo si la tarea está en offered
 * y el decision_id es nuevo (así un reintento o un accept tardío no deja rechazos de ruido). Si la decisión
 * es inválida el gate del accept decide.
 */
export const ap = (eng: { decide(raw: unknown, now: string): unknown; decisions(): HumanDecision[]; state(): { task_id: string; state: string }[]; apply(raw: unknown, now: string): any }, e: Event, now: string) => {
  if (e.kind === "accept" && eng.state().some((c) => c.task_id === e.task_id && c.state === "offered") && !eng.decisions().some((d) => d.decision_id === e.payload.decision_id))
    eng.decide(decisionFor(e), now);
  return eng.apply(e, now);
};
