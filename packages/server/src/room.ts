// Motor del cuarto: log encadenado, validación de mensajes y máquina de fases.
// No sabe nada de HTTP; index.ts lo expone.
import {
  ALLOWED, BODIES, DAYS, Envelope, FINAL_PHASES, GENESIS, TS_WINDOW_MS,
  eventHash, hashOf, signingPayload, verifyValue,
} from "@agent-board/protocol";
import type { AgentType, Commitment, Constraints, Option, Phase, Rules } from "@agent-board/protocol";
import { randomBytes } from "node:crypto";
import { db } from "./db.ts";
import { computeOptions } from "./facilitator.ts";
import { FLAG_FOR_REJECT, checkRate, scanNote } from "./supervisor.ts";

export type Participant = {
  id: string; room_id: string; invite: string; label: string; token: string | null;
  display_name: string | null; platform: string | null; public_key: string | null;
  joined_at: string | null; read_seq: number;
};

type State = {
  round: number;
  submitted: Record<string, Constraints>;
  options: Option[];
  votes: Record<string, string[]>;
  tally?: Record<string, number>;
  winner?: Option;
  commitments: Commitment[];
  reserve_auto_assigned?: boolean;
  /** Último bloqueo del facilitador, para que cada agente lo vea al reintentar. */
  last_block?: { blocking: string; hints: unknown[]; message: string };
};

export type Room = {
  id: string; name: string; rules: Rules; rules_hash: string; phase: Phase;
  phase_started: string; phase_deadline: string | null; state: State; created_at: string;
};

/** Rechazo de un mensaje: se devuelve al agente y también queda en el log. */
export class Reject extends Error {
  code: string; hint: string; status: 400 | 401 | 403 | 409 | 429;
  constructor(code: string, message: string, hint: string, status: 400 | 401 | 403 | 409 | 429 = 400) {
    super(message); this.code = code; this.hint = hint; this.status = status;
  }
}

const now = () => new Date().toISOString();
export const emptyState = (): State => ({ round: 1, submitted: {}, options: [], votes: {}, commitments: [] });

// ---------- Persistencia ----------

export function loadRoom(id: string): Room | undefined {
  const r = db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as any;
  return r && { ...r, rules: JSON.parse(r.rules), state: JSON.parse(r.state) };
}

function save(room: Room) {
  db.prepare("UPDATE rooms SET phase = ?, phase_started = ?, phase_deadline = ?, state = ? WHERE id = ?")
    .run(room.phase, room.phase_started, room.phase_deadline, JSON.stringify(room.state), room.id);
}

export const joined = (roomId: string) =>
  db.prepare("SELECT * FROM participants WHERE room_id = ? AND joined_at IS NOT NULL ORDER BY joined_at, id").all(roomId) as Participant[];

// ---------- Log encadenado ----------

type Row = {
  room_id: string; seq: number; type: string; from_id: string; to_id: string; body: string;
  note: string | null; private: number; signed: number; ts: string; prev_hash: string; hash: string;
  /** Sal del hash público de un evento sellado. Las filas anteriores a esta columna no tienen. */
  salt?: string | null;
};

/** Quién puede leer el contenido de un evento. */
export const PRIVATE = 1, MEMBERS_ONLY = 2;

/**
 * Lo que cualquiera puede ver de un evento. Los privados (restricciones, votos) salen solo como hash.
 * Los de solo miembros (mensajes de un cuarto abierto sin transcript) también, salvo para los miembros.
 * El hash de la cadena se calcula sobre la vista pública, así que cualquiera verifica el log sin leer los mensajes.
 */
function publicView(r: Row, member = false) {
  const body = JSON.parse(r.body);
  const sealed = r.private === PRIVATE || (r.private === MEMBERS_ONLY && !member);
  return {
    room_id: r.room_id, seq: r.seq, type: r.type, from: r.from_id, to: r.to_id,
    // Con sal: un voto o un "sí" tienen tan pocas variantes que sin ella se adivinan probando hashes.
    body: sealed ? { hash: hashOf(r.salt ? { body, note: r.note, salt: r.salt } : { body, note: r.note }) } : body,
    note: sealed ? null : r.note,
    signed: !!r.signed, ts: r.ts, prev_hash: r.prev_hash,
  };
}

export function append(roomId: string, e: { type: string; from: string; to?: string; body: unknown; note?: string; private?: boolean | 1 | 2; signed?: boolean }) {
  const last = db.prepare("SELECT seq, hash FROM events WHERE room_id = ? ORDER BY seq DESC LIMIT 1").get(roomId) as { seq: number; hash: string } | undefined;
  const row: Row = {
    room_id: roomId, seq: (last?.seq ?? 0) + 1, type: e.type, from_id: e.from, to_id: e.to ?? "room",
    body: JSON.stringify(e.body ?? {}), note: e.note ?? null, private: e.private === true ? PRIVATE : (e.private || 0), signed: e.signed ? 1 : 0,
    ts: now(), prev_hash: last?.hash ?? GENESIS, hash: "",
  };
  if (row.private) row.salt = randomBytes(16).toString("hex");
  row.hash = eventHash(publicView(row));
  db.prepare("INSERT INTO events (room_id, seq, type, from_id, to_id, body, note, private, signed, ts, prev_hash, hash, salt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.room_id, row.seq, row.type, row.from_id, row.to_id, row.body, row.note, row.private, row.signed, row.ts, row.prev_hash, row.hash, row.salt ?? null);
  return { event_id: `e_${roomId}_${row.seq}`, seq: row.seq, hash: row.hash };
}

const rows = (roomId: string, after = 0) =>
  db.prepare("SELECT * FROM events WHERE room_id = ? AND seq > ? ORDER BY seq").all(roomId, after) as Row[];

export const lastSeq = (roomId: string) =>
  (db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM events WHERE room_id = ?").get(roomId) as { s: number }).s;

/** Log público: cada evento con su `prev_hash` y `hash`. */
export const publicLog = (roomId: string, after = 0) => rows(roomId, after).map((r) => ({ ...publicView(r), hash: r.hash }));

/** Buzón de un participante: lo que no es privado y no escribió él mismo. Los mensajes de solo miembros llegan abiertos. */
export const inboxFor = (roomId: string, participantId: string, after: number) =>
  rows(roomId, after).filter((r) => r.private !== PRIVATE && r.from_id !== participantId).map((r) => ({ ...publicView(r, true), hash: r.hash }));

/** Log completo como lo ve un miembro: lo de solo miembros abierto. */
export const memberLog = (roomId: string, after = 0) =>
  rows(roomId, after).filter((r) => r.private !== PRIVATE).map((r) => ({ ...publicView(r, true), hash: r.hash }));

/** Recalcula toda la cadena desde las filas guardadas. Detecta filas editadas, borradas o reordenadas. */
export function verifyLog(roomId: string): { ok: boolean; events: number; broken_at?: number; reason?: string } {
  let prev = GENESIS, expected = 1;
  const all = rows(roomId);
  for (const r of all) {
    if (r.seq !== expected) return { ok: false, events: all.length, broken_at: expected, reason: "missing_event" };
    if (r.prev_hash !== prev) return { ok: false, events: all.length, broken_at: r.seq, reason: "prev_hash_mismatch" };
    if (eventHash(publicView(r)) !== r.hash) return { ok: false, events: all.length, broken_at: r.seq, reason: "hash_mismatch" };
    prev = r.hash; expected++;
  }
  return { ok: true, events: all.length };
}

// ---------- Fases ----------

function setPhase(room: Room, to: Phase, reason: string, extra: Record<string, unknown> = {}) {
  append(room.id, { type: "phase", from: "server", body: { from: room.phase, to, reason, ...extra } });
  room.phase = to;
  room.phase_started = now();
  const secs = (room.rules.deadlines as Record<string, number>)[to];
  room.phase_deadline = secs ? new Date(Date.now() + secs * 1000).toISOString() : null;
  save(room);
}

/** Sale de `open`: lo llama el creador, el cupo lleno o el plazo. */
export function startRoom(room: Room, reason: string) {
  if (room.phase !== "open") throw new Reject("wrong_phase", `El cuarto ya está en la fase ${room.phase}.`, "No hace falta abrirlo otra vez.", 409);
  if (joined(room.id).length < 2) {
    if (reason === "deadline") return setPhase(room, "failed", "not_enough_participants");
    throw new Reject("not_enough_participants", "Hacen falta al menos 2 participantes.", "Espera a que entren más.", 409);
  }
  setPhase(room, "constraints", reason);
}

function afterConstraints(room: Room, reason: string) {
  const subs = Object.values(room.state.submitted);
  if (!subs.length) return setPhase(room, "failed", "no_constraints");
  setPhase(room, "options", reason);
  const result = computeOptions(room.rules, subs, joined(room.id).length);
  if ("blocking" in result) {
    // Se anuncia qué tipo de restricción bloquea y qué ofrece el catálogo, nunca quién pidió qué.
    const maxRounds = room.rules.max_rounds ?? 3;
    const block = (room.rules.hints ?? "catalog") === "catalog"
      ? { blocking: result.blocking, hints: result.hints, message: result.message }
      : { blocking: result.blocking, hints: [], message: "Ningún lugar cumple con todos." };
    append(room.id, { type: "blocked", from: "facilitator", body: { ...block, round: room.state.round, rounds_left: maxRounds - room.state.round } });
    room.state.last_block = block;
    if (room.state.round >= maxRounds) return setPhase(room, "failed", "blocked");
    room.state.round += 1;
    room.state.submitted = {};
    return setPhase(room, "constraints", "blocked_retry");
  }
  room.state.options = result.options;
  append(room.id, { type: "options", from: "facilitator", body: { options: result.options } });
  setPhase(room, "voting", "options_published");
}

function afterVoting(room: Room, reason: string) {
  const people = joined(room.id);
  const voters = Object.keys(room.state.votes).length;
  if (voters / people.length < room.rules.quorum) return setPhase(room, "failed", "no_quorum", { voted: voters, of: people.length });
  const tally: Record<string, number> = Object.fromEntries(room.state.options.map((o) => [o.option_id, 0]));
  for (const approve of Object.values(room.state.votes)) for (const id of approve) tally[id]++;
  // Más aprobaciones; en empate, la más barata; si sigue, la de menor posición.
  const winner = room.state.options.map((o, i) => ({ o, i })).sort((a, b) =>
    tally[b.o.option_id] - tally[a.o.option_id] || a.o.price_mxn - b.o.price_mxn || a.i - b.i)[0].o;
  room.state.tally = tally;
  room.state.winner = winner;
  room.state.commitments = [
    ...people.map((p): Commitment => ({ commitment_id: `c_attend_${p.label}`, task: "attend", assignee: p.id, state: "assigned" })),
    { commitment_id: "c_reserve", task: "reserve", assignee: null, state: "open" },
  ];
  setPhase(room, "commitments", reason, { tally, winner: winner.option_id });
  append(room.id, { type: "commitments", from: "facilitator", body: { winner, commitments: room.state.commitments } });
}

function commitmentChanged(room: Room, c: Commitment, by: "facilitator" | "supervisor") {
  append(room.id, { type: "commitment", from: by, body: { ...c } });
}

function checkDone(room: Room) {
  const cs = room.state.commitments;
  const reserve = cs.find((c) => c.task === "reserve")!;
  if (reserve.state === "fulfilled" && cs.every((c) => c.task !== "attend" || c.state !== "assigned")) {
    setPhase(room, "closed", "all_fulfilled", { winner: room.state.winner?.option_id, confirmation_by: reserve.assignee });
  }
}

/** Revisa plazos. Lo llama el temporizador del servidor una vez por segundo. */
export function tick(room: Room) {
  if (FINAL_PHASES.includes(room.phase) || !room.phase_deadline) return;
  const t = Date.now(), start = Date.parse(room.phase_started), end = Date.parse(room.phase_deadline);

  if (room.phase === "commitments" && t >= start + (end - start) / 2 && !room.state.reserve_auto_assigned) {
    room.state.reserve_auto_assigned = true;
    const reserve = room.state.commitments.find((c) => c.task === "reserve")!;
    if (reserve.state === "open") {
      // Nadie se ofreció: le toca al primero que entró, sin contar al festejado.
      const pick = joined(room.id).find((p) => p.label !== room.rules.honoree);
      if (pick) { reserve.assignee = pick.id; reserve.state = "assigned"; commitmentChanged(room, reserve, "facilitator"); }
    }
    save(room);
  }
  if (t < end) return;

  if (room.phase === "open") return startRoom(room, "deadline");
  if (room.phase === "constraints") return afterConstraints(room, "deadline");
  if (room.phase === "voting") return afterVoting(room, "deadline");
  if (room.phase === "commitments") {
    for (const c of room.state.commitments) {
      if (c.state === "assigned" || c.state === "accepted" || c.state === "open") { c.state = "breached"; commitmentChanged(room, c, "supervisor"); }
    }
    const reserve = room.state.commitments.find((c) => c.task === "reserve")!;
    setPhase(room, reserve.state === "fulfilled" ? "closed" : "failed", reserve.state === "fulfilled" ? "deadline" : "reserve_breached");
  }
}

// ---------- Mensajes de los agentes ----------

export function handleMessage(room: Room, p: Participant, raw: unknown) {
  const type: unknown = (raw as any)?.type ?? null;
  // Límite de mensajes: el exceso se rechaza sin escribir en el log, salvo una bandera la primera vez.
  const rate = checkRate(room.id, p.id, room.rules.rate_per_minute);
  if (!rate.ok) {
    if (rate.first) append(room.id, { type: "flag", from: "supervisor", body: { participant: p.id, kind: "rate_limited", action: "messages_rejected" } });
    throw new Reject("rate_limited", `Mandaste más de ${room.rules.rate_per_minute} mensajes en un minuto.`, "Espera un minuto antes de volver a intentar.", 429);
  }
  try {
    return apply(room, p, raw);
  } catch (e) {
    if (e instanceof Reject) {
      const r = append(room.id, { type: "rejected", from: "server", body: { participant: p.id, attempted_type: typeof type === "string" ? type.slice(0, 40) : null, reason: e.code } });
      const kind = FLAG_FOR_REJECT[e.code];
      if (kind) append(room.id, { type: "flag", from: "supervisor", body: { participant: p.id, event_seq: r.seq, kind, action: "message_rejected" } });
    }
    throw e;
  }
}

function apply(room: Room, p: Participant, raw: unknown) {
  const parsed = Envelope.safeParse(raw);
  if (!parsed.success) {
    throw new Reject("invalid_envelope", `El sobre no es válido: ${parsed.error.issues[0].path.join(".") || "(raíz)"}: ${parsed.error.issues[0].message}`,
      'Manda {"type": "...", "body": {...}}. Tipos válidos: constraints, vote, volunteer, commit, fulfill.');
  }
  const env = parsed.data;
  const type = env.type as AgentType;

  if ((env.from && env.from !== p.id) || (env.room_id && env.room_id !== room.id)) {
    throw new Reject("from_mismatch", "El sobre dice venir de otro participante o de otro cuarto.", `Tu participant_id es ${p.id}; no puedes escribir a nombre de nadie más.`, 403);
  }
  if (env.note && env.note.length > room.rules.note_max) {
    throw new Reject("note_too_long", `La nota excede ${room.rules.note_max} caracteres.`, "Acorta la nota o quítala.");
  }

  // Firma: obligatoria para quien entró con llave pública. Sin llave, el mensaje queda marcado como no firmado.
  let signed = false;
  if (p.public_key) {
    if (!env.sig || !env.nonce || !env.ts) throw new Reject("signature_required", "Entraste con llave pública: cada mensaje necesita sig, nonce y ts.", "Firma el sobre con tu llave privada.", 401);
    if (!verifyValue(signingPayload(env, room.id, p.id), env.sig, p.public_key)) throw new Reject("bad_signature", "La firma no coincide con la llave que registraste al entrar. Suele pasar cuando ~/.agentroom se regeneró después del join.", "Vuelve a correr el comando join con tu link de invitación (registra tu llave actual) y repite este comando. No hace falta reinstalar nada.", 401);
    if (!(Math.abs(Date.now() - Date.parse(env.ts)) <= TS_WINDOW_MS)) throw new Reject("stale_ts", "El ts del sobre está fuera de la ventana de 2 minutos.", "Genera el sobre de nuevo con la hora actual en UTC.", 401);
    signed = true;
  }
  if (env.nonce) {
    const fresh = db.prepare("INSERT OR IGNORE INTO nonces (room_id, participant_id, nonce) VALUES (?,?,?)").run(room.id, p.id, env.nonce).changes;
    if (!fresh) throw new Reject("replayed_nonce", "Ese nonce ya se usó: el mensaje parece un reenvío.", "Genera un sobre nuevo con otro nonce.", 409);
  }

  if (!ALLOWED[room.phase].includes(type)) {
    throw new Reject("wrong_phase", `La fase ${room.phase} no acepta mensajes de tipo ${type}.`,
      ALLOWED[room.phase].length ? `En esta fase puedes mandar: ${ALLOWED[room.phase].join(", ")}.` : "En esta fase no te toca mandar nada. Revisa /state más tarde.", 409);
  }
  const body = BODIES[type].safeParse(env.body);
  if (!body.success) {
    const i = body.error.issues[0];
    throw new Reject("invalid_body", `El body de ${type} no pasa el esquema: ${i.path.join(".") || "(raíz)"}: ${i.message}`, "Revisa el ejemplo de ese tipo en agent.md.");
  }

  const s = room.state;
  // Una nota que parece una orden o un pedido de datos no se guarda: queda solo su hash y una bandera.
  const suspicious = !!env.note && scanNote(env.note);
  const common = { from: p.id, note: suspicious ? undefined : env.note, signed };
  const flagNote = (seq: number) => {
    if (suspicious) append(room.id, { type: "flag", from: "supervisor", body: { participant: p.id, event_seq: seq, kind: "injection_suspected", action: "note_hidden", note_hash: hashOf(env.note) } });
  };
  let result: { event_id: string; seq: number; hash: string };

  if (type === "constraints") {
    s.submitted[p.id] = body.data as Constraints;
    result = append(room.id, { ...common, type, to: "facilitator", body: body.data, private: true });
    flagNote(result.seq);
    save(room);
    if (joined(room.id).every((x) => s.submitted[x.id])) afterConstraints(room, "all_submitted");
  } else if (type === "vote") {
    const approve = [...new Set((body.data as { approve: string[] }).approve)];
    const unknown = approve.find((id) => !s.options.some((o) => o.option_id === id));
    if (unknown) throw new Reject("invalid_body", `La opción ${unknown} no existe.`, `Opciones válidas: ${s.options.map((o) => o.option_id).join(", ")}.`);
    s.votes[p.id] = approve;
    result = append(room.id, { ...common, type, body: { approve }, private: true });
    flagNote(result.seq);
    save(room);
    if (joined(room.id).every((x) => s.votes[x.id])) afterVoting(room, "all_voted");
  } else {
    const data = body.data as { commitment_id?: string; accept?: boolean; task?: string };
    const c = type === "volunteer" ? s.commitments.find((x) => x.task === "reserve")! : s.commitments.find((x) => x.commitment_id === data.commitment_id);
    if (!c) throw new Reject("unknown_commitment", `No existe el compromiso ${data.commitment_id}.`, "Revisa tus compromisos en /state.");
    if (type === "volunteer") {
      if (c.state !== "open") throw new Reject("already_taken", "La reserva ya tiene responsable.", "No hace falta que te ofrezcas.", 409);
      c.assignee = p.id; c.state = "accepted";
    } else {
      if (c.assignee !== p.id) throw new Reject("not_assignee", "Ese compromiso no es tuyo.", "Solo puedes aceptar o cumplir tus propios compromisos.", 403);
      if (type === "commit") {
        if (c.state !== "assigned") throw new Reject("invalid_state", `El compromiso está en estado ${c.state}.`, "Solo se puede aceptar o rechazar un compromiso en estado assigned.", 409);
        // Asistir no requiere evidencia en el MVP: aceptar ya lo cumple.
        if (data.accept) c.state = c.task === "attend" ? "fulfilled" : "accepted";
        else if (c.task === "reserve") { c.state = "open"; c.assignee = null; }
        else c.state = "declined";
      } else {
        if (c.task !== "reserve" || c.state !== "accepted") throw new Reject("invalid_state", `No se puede cumplir ${c.commitment_id} en estado ${c.state}.`, "Primero acepta el compromiso con commit.", 409);
        c.state = "fulfilled";
      }
    }
    result = append(room.id, { ...common, type, body: body.data });
    flagNote(result.seq);
    commitmentChanged(room, c, "facilitator");
    save(room);
    checkDone(room);
  }
  return { event_id: result.event_id, seq: result.seq, signed, phase: room.phase };
}

// ---------- Acuerdo ----------

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Resumen del acuerdo cuando el cuarto cierra, listo para que el agente se lo cuente a su persona
 * o lo pase a su calendario. La fecha es la primera vez que cae ese día de la semana después de
 * crearse el cuarto.
 */
export function agreementFor(room: Room) {
  const w = room.state.winner;
  if (room.phase !== "closed" || !w) return null;
  const venue = room.rules.venues.find((v) => v.venue_id === w.venue_id)?.name ?? w.venue_id;
  const d = new Date(`${room.created_at.slice(0, 10)}T00:00:00Z`);
  const weekday = (DAYS.indexOf(w.day as (typeof DAYS)[number]) + 1) % 7;
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== weekday);
  const date = d.toISOString().slice(0, 10);
  const [h, m] = w.time.split(":").map(Number);
  const end = h + 2 >= 24 ? "23:59" : `${pad(h + 2)}:${pad(m)}`;
  const people = joined(room.id);
  const name = (id: string | null) => people.find((p) => p.id === id)?.display_name ?? id;
  const reserve = room.state.commitments.find((c) => c.task === "reserve");
  const fulfill = db.prepare("SELECT body FROM events WHERE room_id = ? AND type = 'fulfill' ORDER BY seq DESC LIMIT 1").get(room.id) as { body: string } | undefined;
  const confirmation = fulfill ? (JSON.parse(fulfill.body).evidence?.confirmation as string) : null;
  const attendees = room.state.commitments.filter((c) => c.task === "attend" && c.state === "fulfilled").map((c) => name(c.assignee));
  const timezone = room.rules.timezone ?? "America/Mexico_City";
  const zone = w.zone.charAt(0).toUpperCase() + w.zone.slice(1);
  return {
    room_id: room.id, title: room.name, venue_id: w.venue_id, venue, zone: w.zone, day: w.day, date, time: w.time, timezone,
    price_mxn: w.price_mxn, reserved_by: name(reserve?.assignee ?? null), confirmation, attendees,
    calendar: {
      title: `${room.name}: cena en ${venue}`,
      start: `${date}T${w.time}:00`, end: `${date}T${end}:00`, timezone,
      location: `${venue}, ${zone}`,
      description: `Acuerdo del cuarto ${room.id}. ${w.price_mxn} MXN por persona. Reserva ${confirmation ?? "sin código"} a nombre de ${name(reserve?.assignee ?? null)}. Asisten: ${attendees.join(", ")}.`,
    },
  };
}

// ---------- Estado para un participante ----------

export function stateFor(room: Room, p: Participant) {
  const s = room.state;
  const mine = s.commitments.filter((c) => c.assignee === p.id);
  const reserve = s.commitments.find((c) => c.task === "reserve");
  let next = "Nada por ahora. Vuelve a revisar más tarde.";
  if (room.phase === "open") next = "Espera a que entren los demás y empiece la fase constraints.";
  if (room.phase === "constraints" && !s.submitted[p.id]) next = "Manda tus restricciones con un mensaje de tipo constraints.";
  if (room.phase === "constraints" && s.round > 1 && s.last_block && !s.submitted[p.id]) {
    next = `Intento ${s.round} de ${room.rules.max_rounds ?? 3}: en el anterior no hubo opciones. ${s.last_block.message} Cuéntale esto a tu persona y pregúntale si puede ceder en algo. Si cambia su mandato, actualiza mandato.json, corre init otra vez y manda constraints; si no cambia nada, manda constraints igual.`;
  }
  if (room.phase === "failed" && s.last_block) next = `El cuarto terminó sin acuerdo. ${s.last_block.message} Avísale a tu persona.`;
  if (room.phase === "voting" && !s.votes[p.id]) next = "Vota: manda un mensaje de tipo vote aprobando de 1 a 3 opciones.";
  if (room.phase === "commitments") {
    const pending = mine.find((c) => c.state === "assigned");
    const toFulfill = mine.find((c) => c.task === "reserve" && c.state === "accepted");
    if (pending) next = `Acepta o rechaza ${pending.commitment_id} con un mensaje de tipo commit.`;
    else if (toFulfill) next = "Te toca la reserva. Pídele a tu persona el código de confirmación (no lo inventes ni uses el de un ejemplo) y entrégalo con un mensaje de tipo fulfill.";
    else if (reserve?.state === "open") next = "Nadie ha tomado la reserva. Si tu mandato lo permite, ofrécete con un mensaje de tipo volunteer.";
  }
  if (room.phase === "closed") next = "El cuarto cerró con acuerdo. Cuéntale el resultado a tu persona con los datos de `agreement` y ofrécele agregarlo a su calendario (usa `agreement.calendar`). No lo agregues sin que te lo pida.";
  if (room.phase === "failed" && !s.last_block) next = "El cuarto terminó sin acuerdo. Avísale a tu persona.";
  return {
    room_id: room.id, name: room.name, phase: room.phase, phase_deadline: room.phase_deadline, server_time: now(),
    you: { participant_id: p.id, signed: !!p.public_key, submitted_constraints: !!s.submitted[p.id], voted: !!s.votes[p.id] },
    participants: joined(room.id).map((x) => ({ participant_id: x.id, display_name: x.display_name, platform: x.platform, signed: !!x.public_key })),
    options: s.options, winner: s.winner ?? null, tally: s.tally ?? null,
    your_commitments: mine, reserve: reserve ?? null,
    round: s.round, max_rounds: room.rules.max_rounds ?? 3, last_block: s.last_block ?? null,
    agreement: agreementFor(room),
    allowed_types: ALLOWED[room.phase], next_action: next,
  };
}
