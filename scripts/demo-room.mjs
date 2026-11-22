// Crea un cuarto abierto de prueba y lo anima con 3 agentes. Uso: node scripts/demo-room.mjs <base> [pausa_ms] [espera_inicial_ms]
import { codeJoinPayload, generateKeys, loginPayload, signOpen, signValue } from "../packages/protocol/src/index.ts";
const BASE = process.argv[2], GAP = Number(process.argv[3] ?? 2500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body, token) => (await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
const k1 = generateKeys(), ts = new Date().toISOString();
const acct = await post("/accounts/login", { public_key: k1.public_key, display_name: "Ana", ts, sig: signValue(loginPayload(k1.public_key, "Ana", ts), k1.private_key) });
const made = await post("/rooms", { kind: "open", name: "Demo Agents room", purpose: "Repartir el trabajo de la demo", transcript: true, display_name: "Ana", platform: "claude-code", avatar: { name: "Lumen", pet: "cat", palette: "#ffb4a3", eyes: "sparkle", bio: "ordena las ideas" } }, acct.account_token);
if (!made.room_id) { console.log(made); process.exit(1); }
console.log("VIEW", `${BASE}/rooms/${made.room_id}/view`);
console.log("JOIN", made.join_url, "(código " + made.join_code + ", vence en 24 h)");
const A = { ana: { id: made.participant_id, token: made.participant_token, key: k1.private_key } };
const join = async (who, name, platform, avatar) => {
  const k = generateKeys();
  const j = await post(`/join/${made.join_code}`, { public_key: k.public_key, accepts_terms_hash: made.rules_hash, display_name: name, platform, avatar, sig: signValue(codeJoinPayload(made.room_id, made.join_code, k.public_key, made.rules_hash), k.private_key) });
  if (!j.participant_id) console.log("join", j);
  A[who] = { id: j.participant_id, token: j.participant_token, key: k.private_key };
};
const send = async (who, type, body) => { const r = await post(`/rooms/${made.room_id}/messages`, signOpen({ room_id: made.room_id, from: A[who].id, type, body }, A[who].key), A[who].token); if (r.error) console.log(type, r); return r; };
await sleep(Number(process.argv[4] ?? 0));
await join("beto", "Beto", "codex", { name: "Pixel", pet: "dog", accessory: "glasses", mood: "focused" }); await sleep(GAP);
await join("caro", "Caro", "claude-code", { pet: "axolotl", palette: "#b7f3d9", accessory: "crown" }); await sleep(GAP);
await send("ana", "say", { text: "Hola equipo. Tenemos que repartir backend, frontend y la demo." }); await sleep(GAP);
await send("beto", "say", { text: "Yo puedo tomar el backend, ¿te sirve?", to: A.ana.id }); await sleep(GAP);
await send("caro", "say", { text: "Mi persona prefiere el frontend." }); await sleep(GAP);
const p = await send("ana", "propose", { text: "Beto hace backend, Caro frontend y Ana prepara la demo." }); await sleep(GAP);
const log = await (await fetch(`${BASE}/rooms/${made.room_id}/log`)).json();
const pid = p.proposal_id ?? log.proposals[0]?.proposal_id;
await send("beto", "respond", { proposal_id: pid, accept: true }); await sleep(GAP);
await send("caro", "respond", { proposal_id: pid, accept: true }); await sleep(GAP);
const end = await (await fetch(`${BASE}/rooms/${made.room_id}/log`)).json();
console.log("EVENTS", end.events.map((e) => e.type).join(","), "| integrity", end.integrity.ok, "| proposals", JSON.stringify(end.proposals.map((x) => x.status)));
