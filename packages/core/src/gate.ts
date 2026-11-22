// Policy gate: función pura que evalúa las reglas en orden y devuelve la primera que falla.
import { CONTRACT_VERSION, RULE_VERSION, TRANSITIONS, type Commitment, type Decision, type Event, type HumanDecision, type Registry, type Rule } from "./contract.ts";

export type Ctx = {
  registry: Registry;
  commitment?: Commitment;
  caseLog: Event[];
  usedDecisionIds: Set<string>;
  /** Decisiones humanas registradas, por decision_id. El accept solo es válido si cita una que lo respalde. */
  decisions: Map<string, HumanDecision>;
  /** `${org del proveedor}|${resource_id}` -> task_id. El recurso es propio de la org que lo ofrece. */
  resourceHolders: Map<string, string>;
};

export const holderKey = (registry: Registry, c: Pick<Commitment, "provider_id" | "resource_id">) =>
  `${registry.agents.find((a) => a.agent_id === c.provider_id)?.org_id}|${c.resource_id}`;

const REQUESTER_KINDS = ["accept", "verify", "cancel"];
const PROVIDER_KINDS = ["offer", "counteroffer", "start", "deliver"];

const no = (rule: Rule, reason: string): Decision => ({ allow: false, rule, rule_version: RULE_VERSION, reason });

export function check(event: Event, ctx: Ctx, now: string): Decision {
  const { registry, commitment: c } = ctx;
  const t = Date.parse(now);
  const sender = registry.agents.find((a) => a.agent_id === event.sender_id);
  const recipient = registry.agents.find((a) => a.agent_id === event.recipient_id);
  const orgOf = (id: string) => registry.agents.find((a) => a.agent_id === id)?.org_id;

  if (Number.isNaN(t)) return no("schema", "now no es una fecha ISO válida");
  if (event.contract_version !== CONTRACT_VERSION) return no("contract_version", `versión ${event.contract_version}, se esperaba ${CONTRACT_VERSION}`);
  if (event.expires_at && Date.parse(event.expires_at) <= t) return no("expired", "el evento expiró");
  if (!sender) return no("sender_registered", `remitente ${event.sender_id} no registrado`);
  if (t < Date.parse(sender.valid_from) || t >= Date.parse(sender.valid_until) || (sender.revoked_at && Date.parse(sender.revoked_at) <= t))
    return no("sender_valid", "remitente fuera de vigencia o revocado");
  if (!recipient || (recipient.revoked_at && Date.parse(recipient.revoked_at) <= t)) return no("recipient_registered", `destinatario ${event.recipient_id} no registrado o revocado`);
  if (!sender.capabilities.includes(event.kind)) return no("capability", `el remitente no tiene la capacidad ${event.kind}`);

  // Sin compromiso no hay partes que comparar: lo rechaza transition.
  if (c) {
    if (event.kind !== "request" && (event.case_id !== c.case_id || event.task_id !== c.task_id || event.resource_id !== c.resource_id))
      return no("transition", "el evento no coincide con el caso, la tarea o el recurso del compromiso");
    const senderOrg = sender.org_id;
    const caseOrgs = [orgOf(c.requester_id), orgOf(c.provider_id)];
    if (REQUESTER_KINDS.includes(event.kind) && event.sender_id !== c.requester_id) return no("party", "el remitente no es el requester del caso");
    if (PROVIDER_KINDS.includes(event.kind) && event.sender_id !== c.provider_id) return no("party", "el remitente no es el provider del caso");
    // El destinatario es la contraparte del remitente (reject y receipt: según la org del remitente).
    const counterparty = REQUESTER_KINDS.includes(event.kind) ? c.provider_id
      : PROVIDER_KINDS.includes(event.kind) ? c.requester_id
      : senderOrg === orgOf(c.requester_id) ? c.provider_id : c.requester_id;
    if (event.kind !== "read_evidence" && event.recipient_id !== counterparty) return no("party", "el destinatario no es la contraparte del compromiso");
    // read_evidence lo cubre evidence_scope.
    if ((event.kind === "reject" || event.kind === "receipt") && !caseOrgs.includes(senderOrg)) return no("party", "la org del remitente no es parte del caso");
  }

  if (event.kind === "request") {
    if (c) return no("transition", "ya existe un compromiso para esta tarea");
    if (recipient.org_id === sender.org_id) return no("party", "no se pide a la propia org");
    if (!recipient.capabilities.includes("offer")) return no("party", "el destinatario no tiene la capacidad offer");
    // Un case_id existente solo lo extienden sus dos orgs; si no, un tercero leería la evidencia del caso.
    const first = ctx.caseLog.find((e) => e.kind === "request");
    if (first && (sender.org_id !== orgOf(first.sender_id) || recipient.org_id !== orgOf(first.recipient_id)))
      return no("party", "el case_id ya existe con otras partes");
  } else {
    if (!c) return no("transition", "no existe compromiso para esta tarea");
    if (!TRANSITIONS[event.kind].from.includes(c.state)) return no("transition", `${event.kind} no es válido desde ${c.state}`);
    const source = ctx.caseLog.find((e) => e.event_id === event.source_event_id);
    if (!event.source_event_id || !source) return no("source_event", "source_event_id falta o no existe en el log del caso");
    if (source.task_id !== event.task_id) return no("source_event", "el evento origen es de otra tarea");
    if (event.kind === "receipt" && source.recipient_id !== event.sender_id) return no("source_event", "el recibo debe darlo el destinatario del evento origen");
    if (event.kind === "accept" && event.source_event_id !== c.current_offer_event_id) return no("source_event", "accept debe referenciar la oferta vigente");
    if (event.kind === "verify" && event.source_event_id !== c.delivered_event_id) return no("source_event", "verify debe referenciar el deliver vigente");
  }

  if (event.kind === "accept" && c) {
    const { approver_id, decision_id, scope } = event.payload;
    const approver = registry.people.find((p) => p.person_id === approver_id);
    if (!approver) return no("approval", "el aprobador no existe");
    if (!approver.may_approve) return no("approval", "el aprobador no tiene may_approve");
    if (approver.org_id !== orgOf(c.requester_id)) return no("approval", "el aprobador no es de la org del requester");
    if (approver_id === event.sender_id) return no("approval", "el aprobador no puede ser el remitente");
    if (scope.case_id !== event.case_id || scope.task_id !== event.task_id || scope.resource_id !== event.resource_id || scope.offer_event_id !== c.current_offer_event_id)
      return no("approval", "el scope no coincide con el caso, la tarea, el recurso y la oferta vigente");
    if (ctx.usedDecisionIds.has(decision_id)) return no("approval", "decision_id ya usado");
    // La aprobación la afirma una persona por su canal, no el agente: el decision_id citado tiene que existir y cubrir este accept.
    const d = ctx.decisions.get(decision_id);
    if (!d) return no("approval", "no hay una decisión humana registrada con ese decision_id");
    if (d.person_id !== approver_id) return no("approval", "la decisión es de otra persona");
    if (!d.approve) return no("approval", "la decisión no aprueba");
    if (d.case_id !== scope.case_id || d.task_id !== scope.task_id || d.resource_id !== scope.resource_id || d.offer_event_id !== scope.offer_event_id)
      return no("approval", "la decisión no cubre el alcance de este accept");

    const holder = ctx.resourceHolders.get(holderKey(registry, c));
    if (holder !== undefined && holder !== event.task_id) return no("double_booking", "el recurso ya está tomado por otro compromiso");
  }

  if (event.kind === "verify" && c && !(c.delivered_event_id && c.receipts.includes(c.delivered_event_id)))
    return no("receipt_required", "falta el recibo del deliver vigente");

  if (event.kind === "read_evidence" && c && ![orgOf(c.requester_id), orgOf(c.provider_id)].includes(sender.org_id))
    return no("evidence_scope", "la org del remitente no es parte del caso");

  return { allow: true };
}
