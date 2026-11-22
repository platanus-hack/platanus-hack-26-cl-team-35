// Criterio de cierre del M1: dos clientes locales recorren las cinco fases
// y log/verify detecta una fila alterada a mano.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateKeys, joinPayload, signEnvelope, signValue } from "@agent-board/protocol";

const PORT = 8800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const DB = join(mkdtempSync(join(tmpdir(), "agentrooms-")), "test.db");
const ADMIN = { authorization: "Bearer test-admin", "content-type": "application/json" };
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_TOKEN: "test-admin" }, stdio: "inherit" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await sleep(100);
  }
  throw new Error("el servidor no arrancó");
});
after(() => { server.kill(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = async (r: Response) => ({ status: r.status, ...(await r.json()) as any });
const get = (path: string, token?: string) => fetch(BASE + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(json);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(json);

const VENUES = [
  { venue_id: "v01", name: "Cantina Ficticia", zone: "roma", price_mxn: 420, days: [{ day: "fri", from: "18:00", to: "23:00" }, { day: "sat", from: "18:00", to: "23:30" }], diets: ["vegetarian"], music: true, capacity: 12 },
  { venue_id: "v02", name: "Fonda Inventada", zone: "roma", price_mxn: 380, days: [{ day: "sat", from: "13:00", to: "23:00" }], diets: ["vegetarian"], music: false, capacity: 8 },
  { venue_id: "v03", name: "Terraza Imaginaria", zone: "condesa", price_mxn: 550, days: [{ day: "sat", from: "19:00", to: "23:00" }], diets: ["vegetarian"], music: true, capacity: 20 },
];
const ANA = { budget_max_mxn: 600, days: [{ day: "sat", from: "19:00" }, { day: "sun", from: "19:00" }], zones: ["roma", "condesa"], diet: ["vegetarian"], needs_music: false };
const BETO = { budget_max_mxn: 450, days: [{ day: "fri" }, { day: "sat" }], zones: ["roma", "juarez", "centro"], diet: [], needs_music: false };

type Client = { id: string; token: string; send: (type: any, body: unknown, note?: string) => Promise<any> };

async function createRoom(rules: Record<string, unknown> = {}) {
  const room = await post("/rooms", { name: "Prueba M1", invites: ["ana", "beto"], rules: { venues: VENUES, ...rules } }, ADMIN);
  assert.equal(room.status, 201);
  return room as { room_id: string; rules_hash: string; invites: { label: string; invite: string }[] };
}

/** Cliente con llaves: firma la entrada y cada sobre. */
async function joinSigned(room: Awaited<ReturnType<typeof createRoom>>, label: string) {
  const keys = generateKeys();
  const invite = room.invites.find((i) => i.label === label)!.invite;
  const j = await post(`/rooms/${room.room_id}/join`, {
    invite, display_name: label, platform: "test", public_key: keys.public_key, accepts_terms_hash: room.rules_hash,
    sig: signValue(joinPayload(room.room_id, invite, keys.public_key, room.rules_hash), keys.private_key),
  });
  assert.equal(j.status, 200, JSON.stringify(j));
  const c: Client & { keys: typeof keys; envelope: (type: any, body: unknown) => any } = {
    id: j.participant_id, token: j.participant_token, keys,
    envelope: (type, body) => signEnvelope({ room_id: room.room_id, from: j.participant_id, type, body }, keys.private_key),
    send: (type, body, note) => post(`/rooms/${room.room_id}/messages`, signEnvelope({ room_id: room.room_id, from: j.participant_id, type, body, note }, keys.private_key), { authorization: `Bearer ${j.participant_token}` }),
  };
  return c;
}

/** Cliente sin llaves: la ruta de curl. Sus mensajes quedan como no firmados. */
async function joinUnsigned(room: Awaited<ReturnType<typeof createRoom>>, label: string): Promise<Client> {
  const invite = room.invites.find((i) => i.label === label)!.invite;
  const j = await post(`/rooms/${room.room_id}/join`, { invite, display_name: label, platform: "curl" });
  assert.equal(j.status, 200, JSON.stringify(j));
  return { id: j.participant_id, token: j.participant_token, send: (type, body, note) => post(`/rooms/${room.room_id}/messages`, { type, body, note }, { authorization: `Bearer ${j.participant_token}` }) };
}

test("dos clientes recorren las cinco fases y el log queda íntegro", async () => {
  const room = await createRoom();
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  assert.equal((await get(`${R}/state`, ana.token)).phase, "open");

  const beto = await joinUnsigned(room, "beto");
  assert.equal((await get(`${R}/state`, beto.token)).phase, "constraints", "con el cupo lleno el cuarto arranca solo");

  // Fuera de fase: se rechaza y queda en el log.
  const early = await ana.send("vote", { approve: ["o1"] });
  assert.equal(early.status, 409);
  assert.equal(early.error, "wrong_phase");

  assert.equal((await ana.send("constraints", ANA)).signed, true);
  const last = await beto.send("constraints", BETO);
  assert.equal(last.signed, false);
  assert.equal(last.phase, "voting", "cuando todos mandan, el facilitador publica opciones y abre el voto");

  // Roma, sábado, a la hora más tardía pedida, dentro del presupuesto más bajo; primero la más barata.
  const st = await get(`${R}/state`, beto.token);
  assert.deepEqual(st.options, [
    { option_id: "o1", venue_id: "v02", zone: "roma", day: "sat", time: "19:00", price_mxn: 380 },
    { option_id: "o2", venue_id: "v01", zone: "roma", day: "sat", time: "19:00", price_mxn: 420 },
  ]);

  // Las restricciones de Ana no le llegan a Beto ni salen en el log público: solo su hash.
  const inbox = await get(`${R}/inbox`, beto.token);
  assert.ok(!JSON.stringify(inbox).includes("budget_max_mxn"));
  const log1 = await get(`${R}/log`);
  const cons = log1.events.filter((e: any) => e.type === "constraints");
  assert.equal(cons.length, 2);
  assert.ok(cons.every((e: any) => Object.keys(e.body).join() === "hash"));
  assert.equal((await get(`${R}/inbox`, beto.token)).new_count, 0, "el buzón no repite lo ya leído");

  assert.equal((await ana.send("vote", { approve: ["o9"] })).error, "invalid_body");
  await ana.send("vote", { approve: ["o1", "o2"] });
  assert.equal((await beto.send("vote", { approve: ["o2"] })).phase, "commitments");
  const st2 = await get(`${R}/state`, ana.token);
  assert.deepEqual(st2.tally, { o1: 1, o2: 2 });
  assert.equal(st2.winner.venue_id, "v01");

  assert.equal((await beto.send("commit", { commitment_id: "c_attend_ana", accept: true })).error, "not_assignee");
  await ana.send("volunteer", { task: "reserve" });
  assert.equal((await beto.send("volunteer", { task: "reserve" })).error, "already_taken");
  await ana.send("commit", { commitment_id: "c_attend_ana", accept: true });
  await beto.send("commit", { commitment_id: "c_attend_beto", accept: true });
  assert.equal((await ana.send("fulfill", { commitment_id: "c_reserve", evidence: { confirmation: "reserva lista" } })).error, "invalid_body");
  assert.equal((await ana.send("fulfill", { commitment_id: "c_reserve", evidence: { confirmation: "RES-7Q2K" } })).phase, "closed");

  const log = await get(`${R}/log`);
  const phases = log.events.filter((e: any) => e.type === "phase").map((e: any) => e.body.to);
  assert.deepEqual(phases, ["constraints", "options", "voting", "commitments", "closed"]);
  assert.ok(log.events.some((e: any) => e.type === "rejected" && e.body.reason === "wrong_phase"), "los rechazos quedan en el log");
  assert.deepEqual(await get(`${R}/log/verify`), { status: 200, ok: true, events: log.events.length });
});

test("firma: se rechazan sobres alterados, reenviados, sin firma o a nombre de otro", async () => {
  const room = await createRoom();
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  const beto = await joinUnsigned(room, "beto");
  const H = { authorization: `Bearer ${ana.token}` };

  const tampered = ana.envelope("constraints", ANA);
  tampered.body = { ...ANA, budget_max_mxn: 9999 };
  assert.equal((await post(`${R}/messages`, tampered, H)).error, "bad_signature");

  assert.equal((await post(`${R}/messages`, { type: "constraints", body: ANA }, H)).error, "signature_required");

  const stale = signEnvelope({ room_id: room.room_id, from: ana.id, type: "constraints", body: ANA }, ana.keys.private_key);
  const old = { ...stale, ts: new Date(Date.now() - 5 * 60_000).toISOString() };
  delete (old as any).sig;
  const { signingPayload } = await import("@agent-board/protocol");
  assert.equal((await post(`${R}/messages`, { ...old, sig: signValue(signingPayload(old, room.room_id, ana.id), ana.keys.private_key) }, H)).error, "stale_ts");

  const env = ana.envelope("constraints", ANA);
  assert.equal((await post(`${R}/messages`, env, H)).status, 201);
  assert.equal((await post(`${R}/messages`, env, H)).error, "replayed_nonce");

  // Beto intenta escribir a nombre de Ana.
  const forged = await post(`${R}/messages`, { type: "constraints", from: ana.id, body: BETO }, { authorization: `Bearer ${beto.token}` });
  assert.equal(forged.status, 403);
  assert.equal(forged.error, "from_mismatch");

  // Entrada con una firma que no corresponde a la llave.
  const room2 = await createRoom();
  const k = generateKeys(), other = generateKeys();
  const invite = room2.invites[0].invite;
  const bad = await post(`/rooms/${room2.room_id}/join`, { invite, public_key: k.public_key, accepts_terms_hash: room2.rules_hash, sig: signValue(joinPayload(room2.room_id, invite, k.public_key, room2.rules_hash), other.private_key) });
  assert.equal(bad.error, "bad_signature");
});

test("log/verify detecta una fila alterada a mano", async () => {
  const room = await createRoom();
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  const beto = await joinUnsigned(room, "beto");
  await ana.send("constraints", ANA);
  await beto.send("constraints", BETO);
  assert.equal((await get(`${R}/log/verify`)).ok, true);

  const db = new DatabaseSync(DB);
  // Fila pública: alguien cambia el precio de una opción ya publicada.
  const opt = db.prepare("SELECT seq, body FROM events WHERE room_id = ? AND type = 'options'").get(room.room_id) as { seq: number; body: string };
  db.prepare("UPDATE events SET body = ? WHERE room_id = ? AND seq = ?").run(opt.body.replace("380", "38"), room.room_id, opt.seq);
  assert.deepEqual(await get(`${R}/log/verify`), { status: 200, ok: false, events: (await get(`${R}/log`)).events.length, broken_at: opt.seq, reason: "hash_mismatch" });
  db.prepare("UPDATE events SET body = ? WHERE room_id = ? AND seq = ?").run(opt.body, room.room_id, opt.seq);
  assert.equal((await get(`${R}/log/verify`)).ok, true);

  // Fila privada: alguien cambia las restricciones guardadas de Ana.
  const con = db.prepare("SELECT seq, body FROM events WHERE room_id = ? AND type = 'constraints' ORDER BY seq LIMIT 1").get(room.room_id) as { seq: number; body: string };
  db.prepare("UPDATE events SET body = ? WHERE room_id = ? AND seq = ?").run(con.body.replace("600", "900"), room.room_id, con.seq);
  assert.equal((await get(`${R}/log/verify`)).broken_at, con.seq);
  db.prepare("UPDATE events SET body = ? WHERE room_id = ? AND seq = ?").run(con.body, room.room_id, con.seq);

  // Fila borrada.
  db.prepare("DELETE FROM events WHERE room_id = ? AND seq = 2").run(room.room_id);
  const v = await get(`${R}/log/verify`);
  assert.equal(v.ok, false);
  assert.equal(v.broken_at, 2);
  db.close();
});

test("plazos: quien no responde queda fuera y sin quórum el cuarto falla", async () => {
  const room = await createRoom({ deadlines: { constraints: 1, voting: 1 } });
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  await joinUnsigned(room, "beto");
  await ana.send("constraints", ANA);
  await sleep(1600);
  const st = await get(`${R}/state`, ana.token);
  assert.equal(st.phase, "voting", "vence el plazo y se calcula solo con quien mandó");
  assert.equal(st.options.length, 3, "sin el presupuesto de Beto entran más lugares");
  await ana.send("vote", { approve: ["o1"] });
  await sleep(1600);
  const log = await get(`${R}/log`);
  assert.equal(log.phase, "failed");
  assert.equal(log.events.at(-1).body.reason, "no_quorum");
});

test("sin opciones: se anuncia qué bloquea con una pista, se reabre y al agotar los intentos falla", async () => {
  const room = await createRoom({ max_rounds: 2 });
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  const beto = await joinUnsigned(room, "beto");
  const polanco = { ...BETO, zones: ["polanco"] };
  await ana.send("constraints", ANA);
  assert.equal((await beto.send("constraints", polanco)).phase, "constraints", "se reabre constraints");
  const blocked = (await get(`${R}/log`)).events.find((e: any) => e.type === "blocked");
  assert.equal(blocked.body.blocking, "zones", "dice el tipo de restricción, no de quién es");
  assert.deepEqual(blocked.body.hints[0].zones, ["roma"], "y qué zonas tienen lugares que cumplen todo lo demás");
  assert.equal(blocked.body.rounds_left, 1);
  assert.ok(!JSON.stringify(blocked.body).includes("polanco") && !JSON.stringify(blocked.body).includes("p_beto"), "sin decir quién pidió qué");
  const retry = await get(`${R}/state`, ana.token);
  assert.match(retry.next_action, /Intento 2 de 2.*roma.*pregúntale si puede ceder/s);
  await ana.send("constraints", ANA);
  assert.equal((await beto.send("constraints", polanco)).phase, "failed");
});

test("commitments: si nadie se ofrece, la reserva se asigna y si no se cumple el cuarto falla", async () => {
  const room = await createRoom({ deadlines: { commitments: 2 }, honoree: "ana" });
  const R = `/rooms/${room.room_id}`;
  const ana = await joinSigned(room, "ana");
  const beto = await joinUnsigned(room, "beto");
  await ana.send("constraints", ANA);
  await beto.send("constraints", BETO);
  await ana.send("vote", { approve: ["o1"] });
  await beto.send("vote", { approve: ["o1"] });
  await sleep(1300);
  const st = await get(`${R}/state`, beto.token);
  assert.equal(st.reserve.assignee, beto.id, "a mitad del plazo se asigna al primero que no es el festejado");
  assert.equal(st.reserve.state, "assigned");
  await sleep(1300);
  const log = await get(`${R}/log`);
  assert.equal(log.phase, "failed");
  assert.equal(log.events.at(-1).body.reason, "reserve_breached");
  assert.equal(log.commitments.find((c: any) => c.task === "reserve").state, "breached");
  assert.equal((await get(`${R}/log/verify`)).ok, true);
});
