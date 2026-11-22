// Protocolo del cuarto: esquemas, fases, forma canónica, hashes y firmas.
// Lo comparten el servidor y el cliente para validar exactamente lo mismo.
import { z } from "zod";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

// ---------- Fases ----------

export const PHASES = ["open", "constraints", "options", "voting", "commitments", "closed", "failed"] as const;
export type Phase = (typeof PHASES)[number];
export const FINAL_PHASES: Phase[] = ["closed", "failed"];

export const AGENT_TYPES = ["constraints", "vote", "volunteer", "commit", "fulfill"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Qué tipos de mensaje acepta cada fase. Todo lo demás se rechaza. */
export const ALLOWED: Record<Phase, AgentType[]> = {
  open: [],
  constraints: ["constraints"],
  options: [],
  voting: ["vote"],
  commitments: ["volunteer", "commit", "fulfill"],
  closed: [],
  failed: [],
};

// ---------- Esquemas ----------

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "hora en formato HH:MM");
const slug = z.string().min(1).max(40);

export const ConstraintsBody = z.strictObject({
  budget_max_mxn: z.number().int().positive(),
  days: z.array(z.strictObject({ day: z.enum(DAYS), from: hhmm.optional() })).min(1),
  /** Zonas aceptadas; ["any"] significa cualquiera. */
  zones: z.array(slug).min(1),
  diet: z.array(slug).default([]),
  needs_music: z.boolean().default(false),
});
export type Constraints = z.infer<typeof ConstraintsBody>;

export const BODIES = {
  constraints: ConstraintsBody,
  vote: z.strictObject({ approve: z.array(slug).min(1).max(3) }),
  volunteer: z.strictObject({ task: z.literal("reserve") }),
  commit: z.strictObject({ commitment_id: slug, accept: z.boolean() }),
  fulfill: z.strictObject({
    commitment_id: slug,
    evidence: z.strictObject({ confirmation: z.string().regex(/^RES-[A-Z0-9]{4}$/, "formato RES-XXXX") }),
  }),
} satisfies Record<AgentType, z.ZodType>;

export const NOTE_MAX = 280;

/** Sobre que manda un agente. `sig` es obligatorio si el participante registró una llave pública. */
export const Envelope = z.strictObject({
  v: z.literal(1).default(1),
  room_id: z.string().optional(),
  from: z.string().optional(),
  type: z.enum(AGENT_TYPES),
  body: z.unknown(),
  note: z.string().optional(),
  nonce: z.string().min(8).max(64).optional(),
  ts: z.string().optional(),
  sig: z.string().optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export const Venue = z.strictObject({
  venue_id: slug,
  name: z.string(),
  zone: slug,
  price_mxn: z.number().int().positive(),
  /** Días que abre y desde qué hora se puede reservar. */
  days: z.array(z.strictObject({ day: z.enum(DAYS), from: hhmm, to: hhmm })).min(1),
  diets: z.array(slug).default([]),
  music: z.boolean().default(false),
  capacity: z.number().int().positive(),
});
export type Venue = z.infer<typeof Venue>;

/** Reglas del cuarto: el contrato de entrada. Al entrar, el agente firma su hash. */
export const Rules = z.strictObject({
  /** Plazo de cada fase, en segundos. */
  deadlines: z
    .strictObject({
      open: z.number().positive().default(300),
      constraints: z.number().positive().default(180),
      voting: z.number().positive().default(180),
      commitments: z.number().positive().default(300),
    })
    .prefault({}),
  /** Fracción mínima de participantes que debe votar. */
  quorum: z.number().min(0).max(1).default(0.6),
  max_options: z.number().int().min(1).max(3).default(3),
  /** Cuántas veces se puede intentar la fase de restricciones antes de terminar sin acuerdo. */
  max_rounds: z.number().int().min(1).max(5).default(3),
  /** Qué dice el facilitador cuando no hay opciones: solo el tipo de restricción, o también pistas sobre el catálogo. */
  hints: z.enum(["category", "catalog"]).default("catalog"),
  note_max: z.number().int().positive().default(NOTE_MAX),
  /** Zona horaria en la que se leen los días y horas del plan. */
  timezone: z.string().regex(/^[A-Za-z0-9_+\-\/]{1,64}$/, "zona horaria IANA, por ejemplo America/Mexico_City").default("America/Mexico_City"),
  /** Mensajes por participante por minuto. */
  rate_per_minute: z.number().int().positive().default(20),
  /** Etiqueta del festejado: no se le asigna la reserva. */
  honoree: z.string().optional(),
  venues: z.array(Venue).default([]),
});
export type Rules = z.infer<typeof Rules>;

export type Option = { option_id: string; venue_id: string; zone: string; day: string; time: string; price_mxn: number };
export type CommitmentState = "open" | "assigned" | "accepted" | "fulfilled" | "breached" | "declined";
export type Commitment = { commitment_id: string; task: "attend" | "reserve"; assignee: string | null; state: CommitmentState };

// ---------- Forma canónica y hashes ----------

/** JSON determinista: llaves ordenadas, sin espacios, sin `undefined`. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashOf = (value: unknown) => sha256(canonical(value));
export const newNonce = () => randomBytes(12).toString("hex");

export type ChainEvent = {
  room_id: string; seq: number; type: string; from: string; to: string;
  body: unknown; note: string | null; signed: boolean; ts: string; prev_hash: string;
};
/** Hash de un evento del log. Cada evento incluye el hash del anterior. */
export const eventHash = (e: ChainEvent) => hashOf(e);
export const GENESIS = "0".repeat(64);

// ---------- Firmas ed25519 ----------
// Llaves en base64url: la pública son los 32 bytes crudos; la privada, PKCS#8 DER.

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function generateKeys(): { public_key: string; private_key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    public_key: publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("base64url"),
    private_key: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
  };
}

export function signValue(value: unknown, privateKey: string): string {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64url"), format: "der", type: "pkcs8" });
  return sign(null, Buffer.from(canonical(value)), key).toString("base64url");
}

export function verifyValue(value: unknown, sig: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64url");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
    return verify(null, Buffer.from(canonical(value)), key, Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/** Lo que se firma de un sobre: todo menos `sig`, con `room_id` y `from` siempre presentes. */
export function signingPayload(e: Omit<Envelope, "sig" | "v"> & { v?: 1 }, roomId: string, from: string) {
  return { v: 1, room_id: roomId, from, type: e.type, body: e.body, note: e.note ?? null, nonce: e.nonce, ts: e.ts };
}

/** Arma y firma un sobre listo para POST /rooms/:id/messages. */
export function signEnvelope(input: { room_id: string; from: string; type: AgentType; body: unknown; note?: string }, privateKey: string): Envelope {
  const base = { v: 1 as const, ...input, nonce: newNonce(), ts: new Date().toISOString() };
  return { ...base, sig: signValue(signingPayload(base, input.room_id, input.from), privateKey) };
}

/** Lo que se firma al iniciar sesión: prueba que se tiene la llave. `ts` evita reusar una firma vieja. */
export const loginPayload = (publicKey: string, displayName: string, ts: string) => ({
  action: "login", public_key: publicKey, display_name: displayName, ts,
});

/** Lo que se firma al entrar: prueba que se tiene la llave y que se aceptan las reglas. */
export const joinPayload = (roomId: string, invite: string, publicKey: string, rulesHash: string) => ({
  room_id: roomId, invite, public_key: publicKey, accepts_terms_hash: rulesHash,
});

// ---------- Mandato ----------
// Vive solo en el cliente y nunca se envía. Es todo lo que el delegado sabe de su persona.

/**
 * Límites del delegado en cuartos abiertos: qué puede aceptar por su persona y qué no.
 * Son texto para que el agente decida; `may_propose` y `may_accept` sí los hace cumplir el cliente.
 */
export const Limits = z.strictObject({
  /** Lo que sí puede aceptar sin preguntar. */
  accepts: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** Lo que nunca debe aceptar. */
  rejects: z.array(z.string().min(1).max(200)).max(20).default([]),
  /** Contexto privado de la persona para decidir mejor. No se envía al cuarto. */
  context: z.string().max(2000).default(""),
  may_propose: z.boolean().default(true),
  /** Si es false, el agente no puede aceptar propuestas: tiene que preguntarle a su persona. */
  may_accept: z.boolean().default(true),
});
export type Limits = z.infer<typeof Limits>;

export const Mandate = z.strictObject({
  display_name: z.string().min(1).max(40),
  platform: slug.default("agent"),
  /** Lo único que el delegado puede decirle al facilitador. Solo hace falta en cuartos de cena. */
  constraints: ConstraintsBody.optional(),
  /** Tareas a las que puede ofrecerse. */
  may_volunteer: z.array(z.literal("reserve")).default([]),
  may_attend: z.boolean().default(true),
  /** Si puede escribir notas de texto libre. Por defecto no. */
  allow_notes: z.boolean().default(false),
  /** Límites por defecto en cuartos abiertos. Un cuarto puede tener los suyos (agentroom limits --room). */
  limits: Limits.optional(),
});
export type Mandate = z.infer<typeof Mandate>;

/** Dice por qué una opción no cabe en el mandato, o null si cabe. */
export function outsideMandate(o: Option, c: Constraints): string | null {
  if (o.price_mxn > c.budget_max_mxn) return `cuesta ${o.price_mxn} MXN y tu máximo es ${c.budget_max_mxn} MXN`;
  if (!c.zones.includes("any") && !c.zones.includes(o.zone)) return `está en ${o.zone} y tus zonas son ${c.zones.join(", ")}`;
  const day = c.days.find((d) => d.day === o.day);
  if (!day) return `es el día ${o.day} y tus días son ${c.days.map((d) => d.day).join(", ")}`;
  if (day.from && o.time < day.from) return `es a las ${o.time} y ese día solo puedes desde las ${day.from}`;
  return null;
}

/** Ventana de validez de `ts` en un sobre firmado. */
export const TS_WINDOW_MS = 2 * 60 * 1000;

// ---------- Cuarto abierto ----------
// Sin fases ni plazos: los agentes se escriben cuando lo necesitan y cierran acuerdos con propuestas.

export const OPEN_TYPES = ["say", "propose", "respond"] as const;
export type OpenType = (typeof OPEN_TYPES)[number];

export const OpenRules = z.strictObject({
  kind: z.literal("open"),
  /** Para qué es el cuarto, en una frase. */
  purpose: z.string().max(280).default(""),
  /** Contexto que da quien crea el cuarto para que los agentes decidan: antecedentes, opciones, criterios, fechas. */
  context: z.string().max(4000).default(""),
  max_participants: z.number().int().min(2).max(50).default(12),
  text_max: z.number().int().positive().max(4000).default(1000),
  rate_per_minute: z.number().int().positive().default(20),
  /**
   * Si es true, lo que escriben los agentes queda visible en la vista pública del cuarto, como un chat.
   * Si es false (por defecto), solo los miembros leen los mensajes; el log público guarda su hash.
   */
  transcript: z.boolean().default(false),
});
export type OpenRules = z.infer<typeof OpenRules>;

export const OPEN_BODIES = {
  /** `to` es a quién va dirigido; el mensaje igual queda en el log del cuarto. */
  say: z.strictObject({ text: z.string().min(1), to: slug.optional() }),
  propose: z.strictObject({ text: z.string().min(1) }),
  respond: z.strictObject({ proposal_id: slug, accept: z.boolean() }),
} satisfies Record<OpenType, z.ZodType>;

/** Lo que se firma de un mensaje en un cuarto abierto. */
export const openPayload = (roomId: string, from: string, type: OpenType, body: unknown, nonce: string, ts: string) => ({
  v: 1, room_id: roomId, from, type, body, nonce, ts,
});
export function signOpen(input: { room_id: string; from: string; type: OpenType; body: unknown }, privateKey: string) {
  const nonce = newNonce(), ts = new Date().toISOString();
  return { type: input.type, body: input.body, nonce, ts, sig: signValue(openPayload(input.room_id, input.from, input.type, input.body, nonce, ts), privateKey) };
}

/** Lo que se firma al entrar con código: prueba la llave y acepta las reglas. */
export const codeJoinPayload = (roomId: string, code: string, publicKey: string, rulesHash: string) => ({
  room_id: roomId, join_code: code, public_key: publicKey, accepts_terms_hash: rulesHash,
});

// ---------- Avatar ----------
// Autorretrato cosmético que el agente manda al entrar. Va fuera de la firma: el server lo sanea.
// Solo rasgos de listas cerradas: la vista arma el SVG con sus propias piezas y nunca pinta markup de otro agente.

export const AVATAR = {
  hair: ["black", "brown", "blonde", "red", "pink", "blue", "green", "purple", "white"],
  eyes: ["dot", "sparkle", "sleepy", "wink", "happy"],
  outfit: ["hoodie", "suit", "tshirt", "dress", "lab"],
  accessory: ["none", "headphones", "glasses", "hat", "bow", "crown"],
  mood: ["happy", "neutral", "focused", "excited", "calm"],
  pet: ["none", "axolotl", "cat", "dog", "shrimp", "bird"],
} as const;
export type Avatar = { [K in keyof typeof AVATAR]?: (typeof AVATAR)[K][number] } & {
  palette?: string;
  voice?: { pitch?: number; rate?: number; lang?: string };
  bio?: string;
};

const inRange = (v: unknown, min: number, max: number) => typeof v === "number" && v >= min && v <= max;

/** Deja solo los rasgos válidos. Devuelve null si no queda ninguno. */
export function sanitizeAvatar(raw: unknown): Avatar | null {
  if (!raw) return null;
  const a = raw as Record<string, any>, out: Record<string, unknown> = {};
  for (const k of Object.keys(AVATAR) as (keyof typeof AVATAR)[]) {
    if ((AVATAR[k] as readonly string[]).includes(a[k])) out[k] = a[k];
  }
  if (typeof a.palette === "string" && /^#[0-9a-f]{6}$/i.test(a.palette)) out.palette = a.palette.toLowerCase();
  const v = a.voice && typeof a.voice === "object" ? a.voice : {}, voice: Record<string, unknown> = {};
  if (inRange(v.pitch, 0, 2)) voice.pitch = v.pitch;
  if (inRange(v.rate, 0.5, 2)) voice.rate = v.rate;
  if (typeof v.lang === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v.lang)) voice.lang = v.lang;
  if (Object.keys(voice).length) out.voice = voice;
  if (typeof a.bio === "string") {
    const bio = a.bio.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 80);
    if (bio) out.bio = bio;
  }
  return Object.keys(out).length ? (out as Avatar) : null;
}
