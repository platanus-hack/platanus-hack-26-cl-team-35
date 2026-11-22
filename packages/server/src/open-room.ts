// Cuarto abierto: el espacio donde conviven los agentes. Sin fases ni plazos.
// Cada agente entra con un código, escribe cuando lo necesita y cierra acuerdos con propuestas.
import { randomBytes } from "node:crypto";
import { OPEN_BODIES, OPEN_TYPES, OpenRules, TS_WINDOW_MS, hashOf, openPayload, verifyValue } from "@agent-board/protocol";
import type { Avatar, OpenType } from "@agent-board/protocol";
import { db } from "./db.ts";
import { MEMBERS_ONLY, Reject, append, joined } from "./room.ts";
import type { Participant, Room } from "./room.ts";
import { checkRate } from "./supervisor.ts";

export type Proposal = { proposal_id: string; from: string; text: string; status: "open" | "agreed" | "rejected"; responses: Record<string, boolean>; created_at: string };
type OpenState = { proposals: Proposal[] };

const now = () => new Date().toISOString();
const rid = (n: number) => randomBytes(n).toString("hex");
/** Quien hizo alguna llamada en este lapso cuenta como en línea. */
export const ONLINE_MS = 2 * 60 * 1000;
export const CODE_TTL_MS = 24 * 60 * 60 * 1000;

export const isOpen = (r: Room) => (r.rules as any).kind === "open";
const rulesOf = (r: Room) => r.rules as unknown as OpenRules;
const stateOf = (r: Room) => r.state as unknown as OpenState;
const saveState = (r: Room) => db.prepare("UPDATE rooms SET state = ? WHERE id = ?").run(JSON.stringify(r.state), r.id);

/** Código fácil de dictar: sin 0/O ni 1/I. */
export function newCode(): string {
  const abc = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const b = randomBytes(8);
  const s = [...b].map((x) => abc[x % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Busca el cuarto de un código vigente. */
export function roomForCode(code: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM rooms WHERE join_code = ? AND join_code_expires > ?").get(code.trim().toUpperCase(), now()) as { id: string } | undefined;
}

export function createOpenRoom(input: { name: string; purpose: string; context?: string; transcript?: boolean; owner: string | null; creator?: { public_key: string; display_name: string; platform: string; avatar?: Avatar | null } }) {
  const rules = OpenRules.parse({ kind: "open", purpose: input.purpose, context: input.context ?? "", transcript: !!input.transcript });
  const id = `r_${rid(4)}`, t = now(), code = newCode();
  db.prepare("INSERT INTO rooms (id, name, rules, rules_hash, phase, phase_started, phase_deadline, state, created_at, owner_account, join_code, join_code_expires) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, input.name, JSON.stringify(rules), hashOf(rules), "open", t, null, JSON.stringify({ proposals: [] } satisfies OpenState), t, input.owner, code, new Date(Date.now() + CODE_TTL_MS).toISOString());
  append(id, { type: "room_created", from: "server", body: { name: input.name, kind: "open", purpose: rules.purpose, transcript: rules.transcript, rules_hash: hashOf(rules) } });
  const creator = input.creator && addParticipant(id, input.creator.display_name, input.creator.platform, input.creator.public_key, "owner", input.creator.avatar);
  return { id, rules, rules_hash: hashOf(rules), code, expires: new Date(Date.now() + CODE_TTL_MS).toISOString(), creator };
}

/** Da de alta (o de vuelta) a un participante por su llave. La misma llave siempre es el mismo participante. */
/** `avatar` ya viene saneado (sanitizeAvatar). */
export function addParticipant(roomId: string, displayName: string, platform: string, publicKey: string, via: "code" | "owner", avatar: Avatar | null = null) {
  const existing = db.prepare("SELECT * FROM participants WHERE room_id = ? AND public_key = ?").get(roomId, publicKey) as Participant | undefined;
  if ((existing as any)?.removed_at) throw new Reject("removed", "Quien administra el cuarto te sacó.", "Habla con tu persona: para volver, quien creó el cuarto tiene que dejarte entrar.", 403);
  const av = avatar ? JSON.stringify(avatar) : null;
  if (existing?.joined_at && existing.token) {
    if (av) db.prepare("UPDATE participants SET avatar = ? WHERE room_id = ? AND id = ?").run(av, roomId, existing.id);
    return existing;
  }
  const r = db.prepare("SELECT rules, phase FROM rooms WHERE id = ?").get(roomId) as { rules: string; phase: string };
  if (r.phase === "closed") throw new Reject("room_closed", "El cuarto está cerrado.", "Pídele a quien lo creó que abra otro.", 409);
  if (joined(roomId).length >= (JSON.parse(r.rules) as OpenRules).max_participants) {
    throw new Reject("room_full", "El cuarto ya está lleno.", "Pídele a quien lo creó que haga otro cuarto.", 409);
  }
  const name = displayName.slice(0, 60), plat = platform.slice(0, 30), token = `tok_${rid(16)}`, t = now();
  let id = existing?.id;
  if (existing) {
    db.prepare("UPDATE participants SET token = ?, display_name = ?, platform = ?, avatar = ?, joined_at = ?, last_seen = ? WHERE room_id = ? AND id = ?").run(token, name, plat, av, t, t, roomId, existing.id);
  } else {
    const slug = name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agente";
    id = `p_${slug}`;
    for (let n = 2; db.prepare("SELECT 1 FROM participants WHERE room_id = ? AND id = ?").get(roomId, id); n++) id = `p_${slug}-${n}`;
    db.prepare("INSERT INTO participants (id, room_id, invite, label, token, display_name, platform, public_key, joined_at, last_seen, avatar) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, roomId, `inv_${rid(8)}`, id.slice(2), token, name, plat, publicKey, t, t, av);
  }
  append(roomId, { type: "join", from: id!, signed: true, body: { display_name: name, platform: plat, public_key: publicKey, via, ...(avatar ? { avatar } : {}) } });
  return db.prepare("SELECT * FROM participants WHERE room_id = ? AND id = ?").get(roomId, id) as Participant;
}

export function leaveOpen(r: Room, p: Participant) {
  db.prepare("UPDATE participants SET token = NULL, joined_at = NULL WHERE room_id = ? AND id = ?").run(r.id, p.id);
  append(r.id, { type: "leave", from: p.id, body: { display_name: p.display_name } });
}

/** El dueño o el admin saca a un participante. Su llave ya no puede volver a entrar. */
export function removeMember(r: Room, participantId: string, by: string) {
  const p = db.prepare("SELECT * FROM participants WHERE room_id = ? AND id = ?").get(r.id, participantId) as Participant | undefined;
  if (!p || !p.joined_at) throw new Reject("unknown_member", `No hay nadie con id ${participantId} en el cuarto.`, "Revisa los ids en members.", 404 as any);
  db.prepare("UPDATE participants SET token = NULL, joined_at = NULL, removed_at = ? WHERE room_id = ? AND id = ?").run(now(), r.id, p.id);
  append(r.id, { type: "removed", from: "server", body: { participant_id: p.id, display_name: p.display_name, by } });
  return { ok: true, room_id: r.id, removed: p.id };
}

/** Código nuevo: el anterior deja de servir. */
export function rotateCode(r: Room) {
  if (r.phase === "closed") throw new Reject("room_closed", "El cuarto está cerrado.", "Un cuarto cerrado no recibe a nadie.", 409);
  const code = newCode(), expires = new Date(Date.now() + CODE_TTL_MS).toISOString();
  db.prepare("UPDATE rooms SET join_code = ?, join_code_expires = ? WHERE id = ?").run(code, expires, r.id);
  append(r.id, { type: "code_rotated", from: "server", body: {} });
  return { room_id: r.id, join_code: code, join_code_expires: expires };
}

/** Cierra el cuarto: no entra nadie más y no se aceptan mensajes. El log queda para leerlo. */
export function closeOpen(r: Room, by: string) {
  if (r.phase === "closed") throw new Reject("room_closed", "El cuarto ya está cerrado.", "No hace falta cerrarlo otra vez.", 409);
  for (const x of stateOf(r).proposals) if (x.status === "open") x.status = "rejected";
  db.prepare("UPDATE rooms SET phase = 'closed', phase_started = ?, state = ?, join_code_expires = ? WHERE id = ?").run(now(), JSON.stringify(r.state), now(), r.id);
  append(r.id, { type: "room_closed", from: "server", body: { by } });
  r.phase = "closed";
  return { ok: true, room_id: r.id, phase: "closed" };
}

const online = (p: Participant & { last_seen?: string | null }) => !!p.last_seen && Date.now() - Date.parse(p.last_seen) < ONLINE_MS;

export function membersOf(roomId: string) {
  return (joined(roomId) as (Participant & { last_seen: string | null; avatar: string | null })[]).map((p) => ({
    participant_id: p.id, name: p.display_name, platform: p.platform, online: online(p), last_seen: p.last_seen, avatar: p.avatar ? JSON.parse(p.avatar) as Avatar : null,
  }));
}

/** Lo que ve un participante: quién está, propuestas abiertas, el último acuerdo y qué conviene hacer. */
export function openStateFor(r: Room, p: Participant) {
  const s = stateOf(r);
  const code = db.prepare("SELECT join_code, join_code_expires FROM rooms WHERE id = ?").get(r.id) as { join_code: string; join_code_expires: string };
  const pending = s.proposals.filter((x) => x.status === "open" && x.responses[p.id] === undefined);
  const agreements = s.proposals.filter((x) => x.status === "agreed");
  return {
    kind: "open", room_id: r.id, name: r.name, purpose: rulesOf(r).purpose, context: rulesOf(r).context ?? "", server_time: now(), phase: r.phase,
    transcript: rulesOf(r).transcript,
    visibility: rulesOf(r).transcript
      ? "Lo que escribes aquí se ve en la vista pública del cuarto, como un chat. No pongas nada que tu persona no publicaría."
      : "Lo que escribes aquí solo lo leen los miembros del cuarto.",
    you: { participant_id: p.id, name: p.display_name },
    members: membersOf(r.id),
    join_code: code.join_code_expires > now() ? code.join_code : null, join_code_expires: code.join_code_expires,
    open_proposals: s.proposals.filter((x) => x.status === "open").map(view),
    agreements: agreements.map(view),
    unread: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id = ? AND seq > ? AND from_id != ? AND private != 1").get(r.id, p.read_seq, p.id) as { n: number }).n,
    next_action: r.phase === "closed"
      ? "El cuarto está cerrado: ya no se aceptan mensajes. Cuéntale a tu persona los acuerdos."
      : pending.length
      ? `Hay ${pending.length} propuesta(s) esperando tu respuesta (${pending.map((x) => x.proposal_id).join(", ")}). Pregúntale a tu persona antes de aceptar y responde con room_respond.`
      : "Sigue con tu trabajo. Cuando necesites a los demás, escribe con room_say; para ver lo nuevo usa room_wait o room_inbox.",
  };
}
/** Propuestas para la vista pública: sin texto si el cuarto no tiene transcript. */
export function publicProposals(r: Room) {
  const t = rulesOf(r).transcript;
  return stateOf(r).proposals.map((x) => ({ ...x, text: t ? x.text : null }));
}

const view = (x: Proposal) => ({ proposal_id: x.proposal_id, from: x.from, untrusted_text: x.text, status: x.status, accepted_by: Object.keys(x.responses).filter((k) => x.responses[k]), rejected_by: Object.keys(x.responses).filter((k) => !x.responses[k]) });

/** Un mensaje firmado en un cuarto abierto: say, propose o respond. */
export function handleOpenMessage(r: Room, p: Participant, raw: any) {
  const rules = rulesOf(r);
  if (r.phase === "closed") throw new Reject("room_closed", "El cuarto está cerrado: ya no se aceptan mensajes.", "Cuéntale a tu persona cómo quedó y qué se acordó.", 409);
  const vis = rules.transcript ? undefined : MEMBERS_ONLY;
  const rate = checkRate(r.id, p.id, rules.rate_per_minute);
  if (!rate.ok) throw new Reject("rate_limited", `Mandaste más de ${rules.rate_per_minute} mensajes en un minuto.`, "Espera un minuto antes de volver a intentar.", 429);
  const type = raw?.type as OpenType;
  if (!OPEN_TYPES.includes(type)) throw new Reject("invalid_type", `En un cuarto abierto no existe el tipo ${String(type).slice(0, 20)}.`, `Tipos: ${OPEN_TYPES.join(", ")}.`);
  if (!p.public_key) throw new Reject("signature_required", "En un cuarto abierto cada mensaje va firmado.", "Usa el cliente agentroom.", 401);
  const { nonce, ts, sig } = raw;
  if (typeof nonce !== "string" || typeof ts !== "string" || typeof sig !== "string") throw new Reject("signature_required", "Faltan nonce, ts o sig.", "Usa el cliente agentroom.", 401);
  if (!verifyValue(openPayload(r.id, p.id, type, raw.body, nonce, ts), sig, p.public_key)) throw new Reject("bad_signature", "La firma no coincide con tu llave.", "Vuelve a entrar con el código del cuarto (registra tu llave actual) y repite.", 401);
  if (!(Math.abs(Date.now() - Date.parse(ts)) <= TS_WINDOW_MS)) throw new Reject("stale_ts", "El ts está fuera de la ventana de 2 minutos.", "Revisa el reloj de tu máquina.", 401);
  if (!db.prepare("INSERT OR IGNORE INTO nonces (room_id, participant_id, nonce) VALUES (?,?,?)").run(r.id, p.id, nonce).changes) throw new Reject("replayed_nonce", "Ese nonce ya se usó.", "Genera un mensaje nuevo.", 409);
  const parsed = OPEN_BODIES[type].safeParse(raw.body);
  if (!parsed.success) { const i = parsed.error.issues[0]; throw new Reject("invalid_body", `El body de ${type} no es válido: ${i.path.join(".") || "(raíz)"}: ${i.message}`, "Revisa los parámetros de la herramienta."); }
  const s = stateOf(r);

  if (type === "say") {
    const b = parsed.data as { text: string; to?: string };
    if (b.text.length > rules.text_max) throw new Reject("text_too_long", `El mensaje pasa de ${rules.text_max} caracteres.`, "Acórtalo o divídelo.");
    if (b.to && !joined(r.id).some((x) => x.id === b.to)) throw new Reject("unknown_member", `No hay nadie con id ${b.to} en el cuarto.`, "Usa un participant_id de room_members.");
    const e = append(r.id, { type: "say", from: p.id, to: b.to, body: { text: b.text }, signed: true, private: vis });
    return { event_id: `e_${r.id}_${e.seq}`, seq: e.seq };
  }
  if (type === "propose") {
    const b = parsed.data as { text: string };
    if (b.text.length > rules.text_max) throw new Reject("text_too_long", `La propuesta pasa de ${rules.text_max} caracteres.`, "Acórtala.");
    if (joined(r.id).length < 2) throw new Reject("alone", "Estás solo en el cuarto: no hay con quién acordar.", "Comparte el código del cuarto y espera a que alguien entre.", 409);
    const x: Proposal = { proposal_id: `pr_${s.proposals.length + 1}`, from: p.id, text: b.text, status: "open", responses: { [p.id]: true }, created_at: now() };
    s.proposals.push(x);
    saveState(r);
    const e = append(r.id, { type: "proposal", from: p.id, body: { proposal_id: x.proposal_id, text: x.text }, signed: true, private: vis });
    return { event_id: `e_${r.id}_${e.seq}`, seq: e.seq, proposal_id: x.proposal_id };
  }
  const b = parsed.data as { proposal_id: string; accept: boolean };
  const x = s.proposals.find((y) => y.proposal_id === b.proposal_id);
  if (!x) throw new Reject("unknown_proposal", `No existe la propuesta ${b.proposal_id}.`, "Revisa open_proposals en room_status.", 404 as any);
  if (x.status !== "open") throw new Reject("proposal_closed", `La propuesta ${x.proposal_id} ya está ${x.status}.`, "Haz una propuesta nueva si hace falta.", 409);
  x.responses[p.id] = b.accept;
  const e = append(r.id, { type: "response", from: p.id, body: { proposal_id: x.proposal_id, accept: b.accept }, signed: true });
  const members = joined(r.id).map((m) => m.id);
  if (!b.accept) {
    x.status = "rejected";
    append(r.id, { type: "proposal_closed", from: "server", body: { proposal_id: x.proposal_id, status: "rejected", rejected_by: p.id } });
  } else if (members.every((m) => x.responses[m] === true)) {
    x.status = "agreed";
    append(r.id, { type: "agreement", from: "server", body: { proposal_id: x.proposal_id, text: x.text, accepted_by: members }, private: vis });
  }
  saveState(r);
  return { event_id: `e_${r.id}_${e.seq}`, seq: e.seq, proposal_id: x.proposal_id, status: x.status };
}
