// Rutas /core: casos del motor de compromisos. Cada caso tiene su propio motor y registro.
import { Hono } from "hono";
import type { Context } from "hono";
import { randomBytes } from "node:crypto";
import { CONTRACT_VERSION, Registry } from "@agent-board/core";
import type { Rule } from "@agent-board/core";
import { db } from "../db.ts";
import { caseViewHtml } from "./view.ts";
import { baseUrl } from "../base-url.ts";
import { isAdmin } from "../admin-auth.ts";
import { caseAgentMd } from "./agent-md.ts";
import { createNotifier, enqueue, processPending, safe, swallow } from "./notify.ts";
import { createCase, engineFor, getRegistry, isRevoked, saveInput } from "./store.ts";

type Status = 400 | 401 | 403 | 404 | 409;
const err = (c: Context, status: Status, error: string, message: string, hint: string) => c.json({ error, message, hint }, status);
const now = () => new Date().toISOString();
const newToken = () => `ct_${randomBytes(16).toString("hex")}`;

const noAdmin = (c: Context) => err(c, 401, "unauthorized", "Token de admin incorrecto.", "Usa 'Authorization: Bearer <ADMIN_TOKEN>'.");
const noCase = (c: Context) => err(c, 404, "case_not_found", "Ese caso no existe.", "Revisa el case_id de la URL.");

const HINTS: Record<Rule, string> = {
  contract_version: `Usa contract_version "${CONTRACT_VERSION}".`,
  expired: "El evento o el agente ya venció: pide al admin renovar la vigencia.",
  sender_registered: "Tu agent_id no está en el registro de este caso.",
  sender_valid: "Tu agente está fuera de vigencia o revocado: pide un token nuevo al admin.",
  recipient_registered: "El destinatario no está en el registro de este caso o fue revocado.",
  capability: "Tu agente no tiene permitido este tipo de evento.",
  party: "Solo las partes de la tarea (requester y provider) pueden mandar este evento.",
  transition: "El evento no corresponde al estado actual de la tarea. Revisa GET /core/cases/:id/state.",
  source_event: "source_event_id debe ser un evento previo de la misma tarea y del tipo que espera este paso.",
  approval: "El accept necesita una decisión humana registrada para esta oferta; no la puedes crear tú.",
  double_booking: "Ese recurso ya está comprometido en otra tarea.",
  receipt_required: "Falta el recibo de la entrega antes de verificar.",
  evidence_scope: "Solo puedes leer evidencia de tu propio caso.",
  schema: "El cuerpo no pasa el esquema del evento. Revisa los campos y tipos.",
};
const STATUS: Partial<Record<Rule, Status>> = { transition: 409, double_booking: 409, source_event: 409, receipt_required: 409, schema: 400 };
const reject = (c: Context, f: { rule: Rule; reason: string; rule_version: string }) =>
  c.json({ error: f.rule, message: f.reason, hint: HINTS[f.rule], rule_version: f.rule_version }, STATUS[f.rule] ?? 403);

type Who = { principal_id: string; kind: "agent" | "person"; token: string };
const notifier = createNotifier();
const retry = (caseId: string) => swallow("reintento de avisos", processPending(notifier, caseId));
/** Token del caso de la ruta: de agente o de persona. Un token de otro caso no existe aquí. */
function who(c: Context, caseId: string, kind?: Who["kind"], formToken?: string): Who | Response {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() || c.req.query("token") || formToken;
  if (!token) return err(c, 401, "missing_token", "Falta tu token.", "Manda 'Authorization: Bearer <token>' o ?token=.");
  const w = db.prepare("SELECT principal_id, kind FROM core_tokens WHERE token = ? AND case_id = ?").get(token, caseId) as Omit<Who, "token"> | undefined;
  if (!w) return err(c, 401, "invalid_token", "Ese token no es de este caso o ya no sirve.", "Pide un token vigente al admin del caso.");
  if (kind && w.kind !== kind) return err(c, 403, "wrong_token_kind", `Esta ruta es para tokens de ${kind}.`, "Usa el token que corresponde a tu rol.");
  return { ...w, token };
}

async function bodyOf(c: Context): Promise<any> {
  try { return await c.req.json(); } catch { return undefined; }
}

/** Evento de agente: el caso y el sender deben coincidir con la ruta y el token antes de llegar al motor. */
function checkEnvelope(c: Context, caseId: string, agent: Who, body: any): Response | undefined {
  if (!body || typeof body !== "object") return err(c, 400, "schema", "El cuerpo debe ser un evento JSON.", "Manda un objeto con los campos del evento.");
  if (body.case_id !== caseId) return err(c, 400, "case_mismatch", "El case_id del evento no es el de la ruta.", "Manda eventos de este caso.");
  if (body.sender_id !== agent.principal_id) return err(c, 403, "sender_mismatch", "El sender_id no es el agente de tu token.", `Tu agente es ${agent.principal_id}.`);
}

export const coreRoutes = new Hono();

coreRoutes.post("/cases", async (c) => {
  if (!isAdmin(c)) return noAdmin(c);
  const body = await bodyOf(c);
  const reg = Registry.safeParse(body?.registry);
  if (!reg.success) return err(c, 400, "invalid_registry", `El registro no pasa el esquema: ${reg.error.issues[0].path.join(".")}: ${reg.error.issues[0].message}`, "Revisa el esquema Registry en packages/core.");
  const id = String(body.case_id ?? `case_${randomBytes(4).toString("hex")}`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return err(c, 400, "invalid_case_id", "El case_id solo admite letras, números, punto, guion y guion bajo (1 a 64).", "Usa otro case_id o no mandes uno.");
  if (getRegistry(id)) return err(c, 409, "case_exists", "Ese case_id ya existe.", "Usa otro case_id o no mandes uno.");
  createCase(id, reg.data, now());
  const base = baseUrl(c);
  const issue = (principal_id: string, kind: Who["kind"]) => {
    const token = newToken();
    db.prepare("INSERT INTO core_tokens (token, case_id, principal_id, kind) VALUES (?,?,?,?)").run(token, id, principal_id, kind);
    return token;
  };
  return c.json({
    case_id: id,
    agents: reg.data.agents.map((a) => ({ agent_id: a.agent_id, token: issue(a.agent_id, "agent"), agent_md_url: `${base}/core/cases/${id}/agent.md` })),
    people: reg.data.people.map((p) => ({ person_id: p.person_id, token: issue(p.person_id, "person"), view_url: `${base}/core/cases/${id}/view` })),
  }, 201);
});

coreRoutes.post("/cases/:id/events", async (c) => {
  const id = c.req.param("id");
  const w = who(c, id, "agent");
  if (w instanceof Response) return w;
  const engine = engineFor(id);
  if (!engine) return noCase(c);
  await retry(id);
  const body = await bodyOf(c);
  const bad = checkEnvelope(c, id, w, body);
  if (bad) return bad;
  const t = now();
  const r = engine.apply(body, t);
  if (!r.ok) return reject(c, r);
  if (!r.duplicate) {
    saveInput(id, "event", body, t);
    if (body.kind === "offer" || body.kind === "counteroffer") await swallow("aviso de oferta", notifyOffer(c, id, engine, body.task_id));
  }
  return c.json(r, 201);
});

coreRoutes.post("/cases/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const w = who(c, id, "agent");
  if (w instanceof Response) return w;
  const engine = engineFor(id);
  if (!engine) return noCase(c);
  await retry(id);
  const body = await bodyOf(c);
  const bad = checkEnvelope(c, id, w, body);
  if (bad) return bad;
  const t = now();
  const r = engine.readEvidence(body, t);
  if (!r.ok) return reject(c, r);
  if (!r.duplicate) saveInput(id, "read", body, t);
  return c.json(r);
});

// Entrega por pull: devolver las pendientes es el acuse de entrega.
coreRoutes.get("/cases/:id/inbox", async (c) => {
  const id = c.req.param("id");
  const w = who(c, id, "agent");
  if (w instanceof Response) return w;
  const engine = engineFor(id);
  if (!engine) return noCase(c);
  await retry(id);
  const log = engine.log();
  const pending = engine.outbox().filter((d) => d.recipient_id === w.principal_id && d.status === "pending");
  const deliveries = pending.map((d) => ({ delivery_id: d.delivery_id, event: log.find((e) => e.event_id === d.event_id) }));
  if (pending.length) {
    const t = now();
    const delivery_ids = pending.map((d) => d.delivery_id);
    for (const d of pending) { d.status = "delivered"; d.attempts++; d.last_attempt_at = t; }
    saveInput(id, "ack", { delivery_ids }, t);
  }
  return c.json({ deliveries });
});

coreRoutes.get("/cases/:id/state", async (c) => {
  const id = c.req.param("id");
  const w = who(c, id);
  if (w instanceof Response) return w;
  const engine = engineFor(id);
  if (!engine) return noCase(c);
  await retry(id);
  const log = engine.log();
  // Solo estado y ofertas: la evidencia vive por referencia y se lee por /evidence.
  // Cada quien ve solo las tareas donde su org es parte: un tercero del registro no lee ofertas ni decisiones ajenas.
  const registry = getRegistry(id)!;
  const orgOf = (agentId: string) => registry.agents.find((a) => a.agent_id === agentId)?.org_id;
  const myOrg = w.kind === "agent" ? orgOf(w.principal_id) : registry.people.find((p) => p.person_id === w.principal_id)?.org_id;
  const mine = engine.state().filter((k) => myOrg !== undefined && [orgOf(k.requester_id), orgOf(k.provider_id)].includes(myOrg));
  const commitments = mine.map((k) => ({ ...k, current_offer: log.find((e) => e.event_id === k.current_offer_event_id) ?? null }));
  return c.json({ case_id: id, commitments, decisions: engine.decisions().filter((d: any) => mine.some((k) => k.task_id === d.task_id)) });
});

coreRoutes.post("/cases/:id/revoke", async (c) => {
  if (!isAdmin(c)) return noAdmin(c);
  const id = c.req.param("id");
  const engine = engineFor(id);
  if (!engine) return noCase(c);
  await retry(id);
  const agent_id = (await bodyOf(c))?.agent_id;
  if (!getRegistry(id)!.agents.some((a) => a.agent_id === agent_id)) return err(c, 404, "agent_not_found", "Ese agente no está en el registro del caso.", "Revisa el agent_id.");
  const at = now();
  const r = engine.revoke(agent_id, at);
  if (!r.ok) return reject(c, r);
  saveInput(id, "revoke", { agent_id, at }, at);
  db.prepare("DELETE FROM core_tokens WHERE case_id = ? AND principal_id = ? AND kind = 'agent'").run(id, agent_id);
  return c.json({ ok: true, agent_id, revoked_at: at });
});

// Rotación: el token nuevo reemplaza a los anteriores del agente o de la persona.
coreRoutes.post("/cases/:id/tokens", async (c) => {
  if (!isAdmin(c)) return noAdmin(c);
  const id = c.req.param("id");
  const registry = getRegistry(id);
  if (!registry) return noCase(c);
  const body = await bodyOf(c);
  const person_id = body?.person_id;
  if ((person_id === undefined) === (body?.agent_id === undefined))
    return err(c, 400, "invalid_body", "Manda agent_id o person_id, uno de los dos.", "Ejemplo: { \"agent_id\": \"transportes.rutas\" }.");
  if (person_id !== undefined) {
    if (!registry.people.some((p) => p.person_id === person_id)) return err(c, 404, "person_not_found", "Esa persona no está en el registro del caso.", "Revisa el person_id.");
    const token = newToken();
    db.prepare("DELETE FROM core_tokens WHERE case_id = ? AND principal_id = ? AND kind = 'person'").run(id, person_id);
    db.prepare("INSERT INTO core_tokens (token, case_id, principal_id, kind) VALUES (?,?,?,'person')").run(token, id, person_id);
    return c.json({ person_id, token }, 201);
  }
  const agent_id = body?.agent_id;
  if (!registry.agents.some((a) => a.agent_id === agent_id)) return err(c, 404, "agent_not_found", "Ese agente no está en el registro del caso.", "Revisa el agent_id.");
  if (isRevoked(id, agent_id)) return err(c, 409, "agent_revoked", "Ese agente está revocado.", "Un agente revocado no recibe tokens; registra otro agente.");
  const token = newToken();
  db.prepare("DELETE FROM core_tokens WHERE case_id = ? AND principal_id = ? AND kind = 'agent'").run(id, agent_id);
  db.prepare("INSERT INTO core_tokens (token, case_id, principal_id, kind) VALUES (?,?,?,'agent')").run(token, id, agent_id);
  return c.json({ agent_id, token }, 201);
});

/** Avisa a las personas que pueden aprobar en la org del requester. El link no lleva token: cada quien usa su enlace personal. */
async function notifyOffer(c: Context, caseId: string, engine: NonNullable<ReturnType<typeof engineFor>>, taskId: string) {
  const registry = getRegistry(caseId)!;
  const k = engine.state().find((x) => x.task_id === taskId);
  if (!k) return;
  const org = registry.agents.find((a) => a.agent_id === k.requester_id)?.org_id;
  // El host del link solo sale de PUBLIC_URL (sin ella va solo la ruta). Si saliera del header Host, el agente que manda la oferta elegiría a dónde apunta el aviso.
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  const text = `Hay una oferta que necesita tu decisión. Caso ${caseId}, tarea ${safe(k.task_id)}, recurso ${safe(k.resource_id)}. Ábrela en ${base ?? ""}/core/cases/${encodeURIComponent(caseId)}/view con tu enlace personal de la vista.`;
  for (const p of registry.people) if (p.may_approve && p.org_id === org && p.notify) await enqueue(notifier, caseId, p.person_id, { ...p.notify, text });
}

coreRoutes.get("/cases/:id/agent.md", (c) => {
  const id = c.req.param("id");
  const w = who(c, id, "agent");
  if (w instanceof Response) return w;
  const agent = getRegistry(id)?.agents.find((a) => a.agent_id === w.principal_id);
  if (!agent) return noCase(c);
  const base = baseUrl(c);
  c.header("Cache-Control", "no-store");
  return c.text(caseAgentMd({ base, caseId: id, agent, participants: getRegistry(id)!.agents }), 200, { "content-type": "text/markdown; charset=utf-8" });
});

const noTask = (c: Context, what: string) => err(c, 404, "task_not_found", `No existe la tarea ${what} en este caso.`, "Revisa el task_id con GET /core/cases/:id/state.");

coreRoutes.get("/cases/:id/view", async (c) => {
  const id = c.req.param("id");
  const w = who(c, id, "person");
  if (w instanceof Response) return w;
  const engine = engineFor(id)!;
  await retry(id);
  const registry = getRegistry(id)!;
  const person = registry.people.find((p) => p.person_id === w.principal_id)!;
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return c.html(caseViewHtml({ caseId: id, token: w.token, person, registry, commitments: engine.state(), log: engine.log(), decisions: engine.decisions() }));
});

const DECISION_KEYS = ["task_id", "offer_event_id", "approve", "conditions"];

// Única vía para crear una decisión: el servidor arma person_id, decision_id, alcance y hora.
coreRoutes.post("/cases/:id/decisions", async (c) => {
  const id = c.req.param("id");
  const isForm = (c.req.header("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const body: any = isForm ? await c.req.parseBody().catch(() => undefined) : await bodyOf(c);
  const formToken = isForm && body ? String(body.token ?? "") : "";
  const w = who(c, id, "person", formToken || undefined);
  if (w instanceof Response) return w;
  if (isForm && body) delete body.token;
  const approve = isForm && body ? { true: true, false: false }[String(body.approve) as "true"] : body?.approve;
  const bad = !body || typeof body !== "object" || Object.keys(body).some((k) => !DECISION_KEYS.includes(k))
    || typeof body.task_id !== "string" || typeof body.offer_event_id !== "string" || typeof approve !== "boolean"
    || (body.conditions !== undefined && typeof body.conditions !== "string");
  if (bad) return err(c, 400, "schema", "El cuerpo debe ser { task_id, offer_event_id, approve, conditions? } y nada más.", "No mandes person_id, decision_id ni decided_at: los pone el servidor.");
  const engine = engineFor(id)!;
  await retry(id);
  const k = engine.state().find((x) => x.task_id === body.task_id);
  if (!k) return noTask(c, body.task_id);
  const t = now();
  const decision = { decision_id: `dec_${randomBytes(8).toString("hex")}`, person_id: w.principal_id, case_id: id, task_id: k.task_id, resource_id: k.resource_id, offer_event_id: body.offer_event_id, approve, ...(body.conditions ? { conditions: body.conditions } : {}), decided_at: t };
  const r = engine.decide(decision, t);
  if (!r.ok) return reject(c, r);
  saveInput(id, "decision", decision, t);
  if (isForm) {
    return c.redirect(`/core/cases/${id}/view?token=${encodeURIComponent(w.token)}`, 303);
  }
  return c.json({ decision: r.decision }, 201);
});
