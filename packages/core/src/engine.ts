// Motor de compromisos: aplica eventos tipados al estado en memoria, pasando siempre por el gate.
// Un rechazo no toca estado, log ni outbox; solo queda en rejections().
import { z } from "zod";
import { Event, HumanDecision as HumanDecisionSchema, Registry as RegistrySchema, FINAL_STATES, RULE_VERSION, TRANSITIONS, type Commitment, type Evidence, type HumanDecision, type Registry, type Rule } from "./contract.ts";
import { isDeepStrictEqual } from "node:util";
import { check, holderKey } from "./gate.ts";

export type Rejection = { event: unknown; rule: Rule; rule_version: string; reason: string; at: string };
export type Delivery = { delivery_id: string; event_id: string; recipient_id: string; attempts: number; status: "pending" | "delivered" | "failed"; last_attempt_at?: string };
export type Fail = { ok: false; rule: Rule; rule_version: string; reason: string };
export type ApplyResult = { ok: true; duplicate?: true; commitment: Commitment } | Fail;
export type DecideResult = { ok: true; decision: HumanDecision } | Fail;
export type EvidenceResult = { ok: true; duplicate?: true; evidence: Evidence[] } | Fail;

const MAX_REJECTIONS = 1000;

export function createEngine(input: Registry) {
  const registry = RegistrySchema.parse(input); // lanza si el registro no es válido
  const commitments = new Map<string, Commitment>(); // por task_id
  const log: Event[] = [];
  const usedDecisionIds = new Set<string>();
  const decisions = new Map<string, HumanDecision>(); // por decision_id
  const decisionLog: HumanDecision[] = [];
  const resourceHolders = new Map<string, string>(); // org del proveedor|resource_id -> task_id
  const readSnapshots = new Map<string, Evidence[]>(); // event_id de lectura -> evidencia devuelta
  const outbox: Delivery[] = [];
  const rejections: Rejection[] = [];

  const validNow = (now: string) => z.iso.datetime().safeParse(now).success;
  const reject = (raw: unknown, rule: Rule, reason: string, now: string): Fail => {
    rejections.push({ event: raw, rule, rule_version: RULE_VERSION, reason, at: now });
    if (rejections.length > MAX_REJECTIONS) rejections.shift(); // acotado: un agente que insiste con eventos inválidos no agota la memoria
    return { ok: false, rule, rule_version: RULE_VERSION, reason };
  };

  // Parsea, valida el kind del canal y resuelve duplicados antes del gate. Un duplicado es el mismo
  // event_id con contenido idéntico al ya logueado (ya fue autorizado); con otro contenido se rechaza.
  // Si no es duplicado, pasa por el gate. Devuelve el rechazo ya registrado en cualquier fallo.
  const intake = (raw: unknown, now: string, read: boolean) => {
    // Con now inválido las comparaciones de fechas darían siempre falso y dejarían pasar agentes vencidos o revocados.
    if (!validNow(now)) return reject(raw, "schema", "now no es una fecha ISO válida", now);
    const p = Event.safeParse(raw);
    if (!p.success) return reject(raw, "schema", p.error.message, now);
    const event = p.data;
    if ((event.kind === "read_evidence") !== read)
      return reject(raw, "transition", read ? "readEvidence solo acepta eventos read_evidence" : "read_evidence se envía por readEvidence, no por apply", now);
    const prev = log.find((e) => e.event_id === event.event_id);
    if (prev) return isDeepStrictEqual(prev, event) ? { event, duplicate: true as const } : reject(raw, "schema", "event_id ya usado con otro contenido", now);
    const commitment = commitments.get(event.task_id);
    const d = check(event, { registry, commitment, caseLog: log.filter((e) => e.case_id === event.case_id), usedDecisionIds, decisions, resourceHolders }, now);
    return d.allow ? { event, commitment, duplicate: false as const } : reject(raw, d.rule, d.reason, now);
  };

  const evidenceOf = (case_id: string): Evidence[] =>
    structuredClone(log.flatMap((e) => (e.case_id === case_id && e.kind === "deliver" ? e.payload.evidence : [])));

  return {
    apply(raw: unknown, now: string): ApplyResult {
      const g = intake(raw, now, false);
      if ("ok" in g) return g;
      const { event } = g;
      if (g.duplicate) return { ok: true, duplicate: true, commitment: structuredClone(commitments.get(event.task_id)!) };
      const { commitment } = g;

      // Se calcula sobre copias y se confirma al final.
      const next: Commitment = commitment
        ? structuredClone(commitment)
        : { case_id: event.case_id, task_id: event.task_id, resource_id: event.resource_id, requester_id: event.sender_id, provider_id: event.recipient_id, state: "requested", receipts: [] };
      if (event.kind === "offer" || event.kind === "counteroffer") next.current_offer_event_id = event.event_id;
      if (event.kind === "deliver") next.delivered_event_id = event.event_id;
      if (event.kind === "receipt") next.receipts.push(event.source_event_id!);
      const to = TRANSITIONS[event.kind].to;
      if (to) next.state = to;

      commitments.set(next.task_id, next);
      log.push(event);
      if (event.kind === "accept") usedDecisionIds.add(event.payload.decision_id);
      const key = holderKey(registry, next);
      if (next.state === "accepted") resourceHolders.set(key, next.task_id);
      else if (FINAL_STATES.includes(next.state) && resourceHolders.get(key) === next.task_id) resourceHolders.delete(key);
      outbox.push({ delivery_id: `${event.event_id}:${event.recipient_id}`, event_id: event.event_id, recipient_id: event.recipient_id, attempts: 0, status: "pending" });
      return { ok: true, commitment: structuredClone(next) };
    },

    // La lectura queda en el log como procedencia; no genera entrega ni cambia estado.
    readEvidence(raw: unknown, now: string): EvidenceResult {
      const g = intake(raw, now, true);
      if ("ok" in g) return g;
      // El duplicado devuelve lo que vio la lectura original, no lo que hay ahora.
      if (g.duplicate) return { ok: true, duplicate: true, evidence: structuredClone(readSnapshots.get(g.event.event_id) ?? []) };
      const evidence = evidenceOf(g.event.case_id);
      log.push(g.event);
      readSnapshots.set(g.event.event_id, evidence);
      return { ok: true, evidence: structuredClone(evidence) };
    },

    /** Una persona registra su decisión sobre la oferta vigente. El accept del agente la cita por decision_id. */
    decide(raw: unknown, now: string): DecideResult {
      if (!validNow(now)) return reject(raw, "schema", "now no es una fecha ISO válida", now);
      const p = HumanDecisionSchema.safeParse(raw);
      if (!p.success) return reject(raw, "schema", p.error.message, now);
      const d = p.data;
      const c = commitments.get(d.task_id);
      if (!c) return reject(raw, "transition", "no existe compromiso para esa tarea", now);
      if (c.state !== "offered") return reject(raw, "transition", `no se decide sobre una tarea en ${c.state}`, now);
      const person = registry.people.find((x) => x.person_id === d.person_id);
      const requesterOrg = registry.agents.find((a) => a.agent_id === c.requester_id)?.org_id;
      if (!person) return reject(raw, "approval", "la persona no existe", now);
      if (!person.may_approve) return reject(raw, "approval", "la persona no tiene may_approve", now);
      if (person.org_id !== requesterOrg) return reject(raw, "approval", "la persona no es de la org del requester", now);
      if (d.case_id !== c.case_id || d.resource_id !== c.resource_id || d.offer_event_id !== c.current_offer_event_id)
        return reject(raw, "approval", "la decisión no es sobre la oferta vigente de esta tarea", now);
      if (decisionLog.some((x) => x.person_id === d.person_id && x.offer_event_id === d.offer_event_id))
        return reject(raw, "approval", "la persona ya decidió sobre esta oferta", now);
      if (decisions.has(d.decision_id)) return reject(raw, "approval", "decision_id ya registrado", now);
      decisions.set(d.decision_id, d);
      decisionLog.push(d);
      return { ok: true, decision: structuredClone(d) };
    },

    /** Fija revoked_at del agente en `at`; si ya estaba revocado conserva la fecha más temprana. */
    revoke(agent_id: string, at: string): { ok: true } | Fail {
      const raw = { agent_id, at };
      if (!validNow(at)) return reject(raw, "schema", "at no es una fecha ISO válida", at);
      const agent = registry.agents.find((a) => a.agent_id === agent_id);
      if (!agent) return reject(raw, "sender_registered", `agente ${agent_id} no registrado`, at);
      if (!agent.revoked_at || Date.parse(at) < Date.parse(agent.revoked_at)) agent.revoked_at = at;
      return { ok: true };
    },

    state: (): Commitment[] => structuredClone([...commitments.values()]),
    log: (): Event[] => structuredClone(log),
    decisions: (): HumanDecision[] => structuredClone(decisionLog),
    rejections: (): Rejection[] => [...rejections],
    /** Arreglo vivo: la Task 4 muta attempts/status directamente. */
    outbox: (): Delivery[] => outbox,
  };
}
