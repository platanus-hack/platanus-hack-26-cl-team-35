// Contrato del motor de compromisos: estados, kinds, esquemas y tabla de transiciones.
// Lo consumen el gate, el store y las pruebas; nada aquí tiene efectos.
import { z } from "zod";

export const CONTRACT_VERSION = "core-0.1";
export const RULE_VERSION = "1";

export const STATES = ["requested", "offered", "accepted", "executing", "delivered", "verified", "rejected", "cancelled"] as const;
export type State = (typeof STATES)[number];
export const FINAL_STATES: State[] = ["verified", "rejected", "cancelled"];

export const KINDS = ["request", "offer", "counteroffer", "accept", "start", "deliver", "receipt", "verify", "reject", "cancel", "read_evidence"] as const;
export type Kind = (typeof KINDS)[number];

const Id = z.string().min(1);
const Iso = z.iso.datetime();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const NOTE_MAX = 280;

export const Agent = z.strictObject({
  agent_id: Id,
  provider: Id,
  org_id: Id,
  role: Id,
  capabilities: z.array(z.enum(KINDS)),
  valid_from: Iso,
  valid_until: Iso,
  revoked_at: Iso.optional(),
});
export type Agent = z.infer<typeof Agent>;

export const Person = z.strictObject({
  person_id: Id, org_id: Id, may_approve: z.boolean(),
  /** A dónde avisarle de una oferta pendiente. */
  notify: z.strictObject({ channel: z.enum(["slack", "whatsapp"]), address: z.string().min(1).max(64) }).optional(),
});
export type Person = z.infer<typeof Person>;

export const Registry = z.strictObject({ agents: z.array(Agent), people: z.array(Person) });
export type Registry = z.infer<typeof Registry>;

/** Evidencia por referencia: nunca el contenido. */
export const Evidence = z.strictObject({ ref: Id, sha256: Sha256 });
export type Evidence = z.infer<typeof Evidence>;

/** Decisión que una persona registra por su canal; el accept del agente solo la cita por decision_id. */
export const HumanDecision = z.strictObject({
  decision_id: Id,
  person_id: Id,
  case_id: Id,
  task_id: Id,
  resource_id: Id,
  offer_event_id: Id,
  approve: z.boolean(),
  conditions: z.string().max(NOTE_MAX).optional(),
  decided_at: Iso,
});
export type HumanDecision = z.infer<typeof HumanDecision>;

const AcceptPayload = z.strictObject({
  approver_id: Id,
  decision_id: Id,
  scope: z.strictObject({ case_id: Id, task_id: Id, resource_id: Id, offer_event_id: Id }),
});
const DeliverPayload = z.strictObject({ evidence: z.array(Evidence).min(1) });
const Empty = z.strictObject({});

const base = {
  event_id: Id,
  case_id: Id,
  task_id: Id,
  sender_id: Id,
  recipient_id: Id,
  resource_id: Id,
  contract_version: z.string(),
  created_at: Iso,
  expires_at: Iso.optional(),
  note: z.string().max(NOTE_MAX).optional(),
};

// request no tiene origen; todo lo demás referencia un evento previo.
const variant = <K extends Kind, P extends z.ZodType>(kind: K, payload: P) =>
  z.strictObject({ ...base, kind: z.literal(kind), source_event_id: kind === "request" ? z.undefined().optional() : Id, payload });

export const Event = z.discriminatedUnion("kind", [
  variant("request", Empty),
  variant("offer", Empty),
  variant("counteroffer", Empty),
  variant("accept", AcceptPayload),
  variant("start", Empty),
  variant("deliver", DeliverPayload),
  variant("receipt", Empty),
  variant("verify", Empty),
  variant("reject", Empty),
  variant("cancel", Empty),
  variant("read_evidence", Empty),
]);
export type Event = z.infer<typeof Event>;

/** Transición por kind. `to: null` no cambia estado (receipt, read_evidence). */
export const TRANSITIONS: Record<Kind, { from: State[]; to: State | null }> = {
  request: { from: [], to: "requested" },
  offer: { from: ["requested"], to: "offered" },
  // La contraoferta reemplaza la oferta vigente y deja el compromiso en offered.
  counteroffer: { from: ["offered"], to: "offered" },
  accept: { from: ["offered"], to: "accepted" },
  start: { from: ["accepted"], to: "executing" },
  deliver: { from: ["executing"], to: "delivered" },
  receipt: { from: [...STATES], to: null },
  verify: { from: ["delivered"], to: "verified" },
  reject: { from: ["requested", "offered", "accepted"], to: "rejected" },
  cancel: { from: ["requested", "offered", "accepted", "executing"], to: "cancelled" },
  read_evidence: { from: [...STATES], to: null },
};

export const RULES = [
  "contract_version", "expired", "sender_registered", "sender_valid", "recipient_registered", "capability",
  "party", "transition", "source_event", "approval", "double_booking", "receipt_required", "evidence_scope",
  "schema",
] as const;
export type Rule = (typeof RULES)[number];

export type Decision = { allow: true } | { allow: false; rule: Rule; rule_version: string; reason: string };

/** Compromiso vigente de una tarea: lo que el gate necesita saber del estado actual. */
export type Commitment = {
  case_id: string;
  task_id: string;
  resource_id: string;
  requester_id: string;
  provider_id: string;
  state: State;
  current_offer_event_id?: string;
  delivered_event_id?: string;
  receipts: string[];
};
