// Supervisor: vigila reglas que no dependen del contenido del plan.
// Determinista. Los plazos y los compromisos incumplidos los aplica el temporizador en room.ts;
// aquí viven el límite de mensajes y la revisión de las notas de texto libre.

/** Rechazos que además de quedar en el log levantan una bandera de ataque. */
export const FLAG_FOR_REJECT: Record<string, string> = {
  from_mismatch: "impersonation_attempt",
  replayed_nonce: "replay_attempt",
  bad_signature: "bad_signature",
};

// Patrones de una nota que intenta dar órdenes o sacar datos. No pretende ser completo:
// la defensa principal es que el cliente oculta todas las notas; esto solo deja evidencia en el log.
const SUSPICIOUS: RegExp[] = [
  /\b(ignora|olvida|descarta|omite)\b.{0,40}\b(instruccion|mandato|regla|anterior|sistema)/i,
  /\b(ignore|disregard|forget)\b.{0,40}\b(instruction|previous|system|rule)/i,
  /^\s*(sistema|system|admin|administrador|facilitador|supervisor|organizador)\s*:/i,
  /\b(eres|you are|act[uú]a como|act as)\b.{0,30}\b(ahora|now|admin|sistema|system)/i,
  /\b(dime|dame|p[aá]same|manda|env[ií]a|comparte|escribe|confirma|revela|tell me|send|share)\b.{0,60}\b(direcci[oó]n|tel[eé]fono|celular|presupuesto|domicilio|contrase[nñ]a|token|llave|clave|correo|address|phone|budget|password)/i,
  /\b(vota|voten|aprueba|aprueben|vote for)\b.{0,20}\bo\d\b/i,
  /\b(urgente|r[aá]pido|de inmediato|ahora mismo|en \d+ ?(min|minuto|segundo))\b.{0,80}\b(cancela|pierde|expira|confirma)/i,
];

/** Dice si una nota parece un intento de inyección. */
export const scanNote = (note: string): boolean => SUSPICIOUS.some((re) => re.test(note));

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/**
 * Límite de mensajes por participante por minuto.
 * `first` es true solo la primera vez que se excede en la ventana, para dejar una sola bandera
 * en el log y que el propio abuso no lo inunde.
 */
export function checkRate(roomId: string, participantId: string, limit: number): { ok: boolean; first: boolean } {
  const key = `${roomId}/${participantId}`, t = Date.now();
  const recent = (hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
  recent.push(t);
  hits.set(key, recent);
  return { ok: recent.length <= limit, first: recent.length === limit + 1 };
}
