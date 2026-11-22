// Avisos a personas (Slack y WhatsApp por Kapso) con cola y reintentos. Un aviso fallido nunca toca el caso.
import { db } from "../db.ts";

db.exec(`CREATE TABLE IF NOT EXISTS core_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, person_id TEXT NOT NULL, payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, claimed_at INTEGER
)`);

export type Message = { channel: "slack" | "whatsapp"; address: string; text: string };
export type SendResult = { status: "sent" | "skipped" | "failed"; error?: string };
export type Notifier = { send(m: Message): Promise<SendResult> };

const MAX_ATTEMPTS = 3;
const STALE_MS = 60_000; // un 'sending' más viejo que esto se da por caído y vuelve a pendiente
const KAPSO = "https://api.kapso.ai/meta/whatsapp/v24.0";

/** Los errores son cadenas propias: nunca el mensaje de fetch ni cuerpos de respuesta, para no filtrar credenciales. */
export function createNotifier(o: { fetch?: typeof globalThis.fetch; env?: Record<string, string | undefined>; timeoutMs?: number } = {}): Notifier {
  const f = o.fetch ?? globalThis.fetch;
  const env = o.env ?? process.env;
  const timeoutMs = o.timeoutMs ?? 5000;
  const post = async (name: string, url: string, headers: Record<string, string>, body: unknown): Promise<{ res?: Response; error?: string }> => {
    try { return { res: await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }) }; }
    catch { return { error: `${name}: error de red` }; }
  };
  return {
    async send(m) {
      if (m.channel === "slack") {
        if (!env.SLACK_BOT_TOKEN) return { status: "skipped", error: "slack: canal apagado" };
        const { res, error } = await post("slack", "https://slack.com/api/chat.postMessage", { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }, { channel: m.address, text: m.text });
        if (!res) return { status: "failed", error };
        if (!res.ok) return { status: "failed", error: `slack: http ${res.status}` };
        const data: any = await res.json().catch(() => ({}));
        return data.ok === true ? { status: "sent" } : { status: "failed", error: `slack: ${String(data.error ?? "ok false").slice(0, 100)}` };
      }
      if (!env.KAPSO_API_KEY || !env.KAPSO_PHONE_NUMBER_ID) return { status: "skipped", error: "whatsapp: canal apagado" };
      const { res, error } = await post("kapso", `${KAPSO}/${encodeURIComponent(env.KAPSO_PHONE_NUMBER_ID)}/messages`, { "X-API-Key": env.KAPSO_API_KEY },
        { messaging_product: "whatsapp", to: m.address, type: "text", text: { body: m.text } });
      if (!res) return { status: "failed", error };
      return res.ok ? { status: "sent" } : { status: "failed", error: `kapso: http ${res.status}` };
    },
  };
}

type Row = { id: number; person_id: string; payload: string; attempts: number };

/** Toma el aviso de forma atómica: solo quien cambia la fila a 'sending' lo envía. */
const claim = (id: number) =>
  db.prepare("UPDATE core_notifications SET status = 'sending', claimed_at = ? WHERE id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?))")
    .run(Date.now(), id, Date.now() - STALE_MS).changes === 1;

async function attempt(n: Notifier, r: Row) {
  if (!claim(r.id)) return;
  let res: SendResult;
  try { res = await n.send(JSON.parse(r.payload)); } catch { res = { status: "failed", error: "error interno al enviar" }; }
  db.prepare("UPDATE core_notifications SET attempts = attempts + 1, status = CASE WHEN ? = 'failed' AND attempts + 1 < ? THEN 'pending' ELSE ? END, last_error = ? WHERE id = ?")
    .run(res.status, MAX_ATTEMPTS, res.status, res.error?.slice(0, 200) ?? null, r.id);
}

/** Guarda el aviso e intenta enviarlo ya. Nunca lanza. */
export async function enqueue(n: Notifier, caseId: string, personId: string, m: Message) {
  const payload = JSON.stringify(m);
  const { lastInsertRowid } = db.prepare("INSERT INTO core_notifications (case_id, person_id, payload) VALUES (?,?,?)").run(caseId, personId, payload);
  await attempt(n, { id: Number(lastInsertRowid), person_id: personId, payload, attempts: 0 }).catch(() => {});
}

/** Un intento más para cada aviso pendiente del caso. Nunca lanza. */
export async function processPending(n: Notifier, caseId: string) {
  const rows = db.prepare("SELECT id, person_id, payload, attempts FROM core_notifications WHERE case_id = ? AND (status = 'pending' OR (status = 'sending' AND claimed_at < ?)) ORDER BY id")
    .all(caseId, Date.now() - STALE_MS) as Row[];
  for (const r of rows) await attempt(n, r).catch(() => {});
}

/** Los avisos son accesorios: si algo falla, el evento ya aplicado no debe devolver 500. */
export async function swallow(label: string, p: Promise<unknown>) {
  try { await p; } catch (e) { console.error(`${label}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`); }
}

/** Texto aportado por agentes: solo caracteres inertes, para que no inyecte menciones ni links en Slack o WhatsApp. */
export const safe = (s: string) => s.replace(/[^A-Za-z0-9@:_-]/g, "_").slice(0, 64);
