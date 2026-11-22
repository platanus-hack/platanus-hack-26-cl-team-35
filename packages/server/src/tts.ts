// Voz de los mensajes con ElevenLabs. La key vive solo en el server; la vista pide el audio por seq.
import { createHash } from "node:crypto";
import { db } from "./db.ts";

const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const BASE = process.env.ELEVENLABS_BASE ?? "https://api.elevenlabs.io";
const MODEL = process.env.ELEVENLABS_MODEL ?? "eleven_flash_v2_5";
// Voces del catálogo de la cuenta; cada agente queda con una fija según su id.
const VOICES = (process.env.ELEVENLABS_VOICES ?? "").split(",").map((v) => v.trim()).filter(Boolean);

export const ttsEnabled = () => !!KEY && VOICES.length > 0;

// ponytail: caché en memoria por proceso, se pierde al reiniciar; pasar a disco si el costo importa.
const MAX = 300;
const cache = new Map<string, Promise<Buffer>>();

/** Texto y voz de un mensaje `say` público, o null si ese seq no es uno. */
function sayOf(roomId: string, seq: number) {
  const row = db.prepare("SELECT from_id, body FROM events WHERE room_id = ? AND seq = ? AND type = 'say' AND private = 0").get(roomId, seq) as { from_id: string; body: string } | undefined;
  if (!row) return null;
  const text = String(JSON.parse(row.body).text ?? "").slice(0, 1000);
  if (!text) return null;
  const p = db.prepare("SELECT avatar FROM participants WHERE id = ?").get(row.from_id) as { avatar: string | null } | undefined;
  const rate = p?.avatar ? JSON.parse(p.avatar).voice?.rate : undefined;
  const voice = VOICES[createHash("sha256").update(row.from_id).digest()[0] % VOICES.length];
  // ElevenLabs acepta speed entre 0.7 y 1.2.
  const speed = typeof rate === "number" ? Math.min(1.2, Math.max(0.7, rate)) : 1;
  return { text, voice, speed };
}

/** Audio mp3 del mensaje. Cada mensaje se paga una sola vez: los pedidos repetidos o simultáneos comparten la misma promesa. */
export function speech(roomId: string, seq: number): Promise<Buffer> | null {
  const key = `${roomId}/${seq}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const say = sayOf(roomId, seq);
  if (!say) return null;
  const job = fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(say.voice)}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: say.text, model_id: MODEL, voice_settings: { speed: say.speed } }),
  }).then(async (r) => {
    if (!r.ok) throw new Error(`elevenlabs ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  job.catch(() => cache.delete(key));
  cache.set(key, job);
  if (cache.size > MAX) cache.delete(cache.keys().next().value!);
  return job;
}
