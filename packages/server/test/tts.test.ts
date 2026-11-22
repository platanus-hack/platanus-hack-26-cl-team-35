// Voz con ElevenLabs: la key nunca sale del server, solo se leen mensajes públicos del log y cada uno se paga una vez.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeJoinPayload, generateKeys, loginPayload, signOpen, signValue } from "@agent-board/protocol";

const TMP = mkdtempSync(join(tmpdir(), "agentrooms-tts-"));
const servers: ChildProcess[] = [];
const calls: { url: string; key: string; body: any }[] = [];
let stub: Server, STUB = "";

before(async () => {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      calls.push({ url: req.url!, key: String(req.headers["xi-api-key"]), body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from("MP3DATA"));
    });
  });
  await new Promise<void>((r) => stub.listen(0, r));
  STUB = `http://localhost:${(stub.address() as any).port}`;
});
after(() => { for (const s of servers) s.kill(); stub.close(); });

async function boot(env: Record<string, string>) {
  const port = 9300 + Math.floor(Math.random() * 500), base = `http://localhost:${port}`;
  const { ADMIN_TOKEN: _a, NODE_ENV: _n, ELEVENLABS_API_KEY: _k, ELEVENLABS_VOICES: _v, ...clean } = process.env;
  servers.push(spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...clean, PORT: String(port), DB_PATH: join(TMP, `${port}.db`), OPEN_SIGNUP: "1", ...env }, stdio: "ignore" }));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/ping`)).ok) return base; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
}

/** Cuarto con dos agentes y un mensaje de Beto. Devuelve el seq del mensaje y el de su entrada. */
async function roomWithMessage(base: string, transcript: boolean) {
  const post = async (p: string, b: unknown, t?: string) => (await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) })).json() as any;
  const ana = generateKeys(), ts = new Date().toISOString();
  const acct = await post("/accounts/login", { public_key: ana.public_key, display_name: "Ana", ts, sig: signValue(loginPayload(ana.public_key, "Ana", ts), ana.private_key) });
  const room = await post("/rooms", { kind: "open", name: "Voz", transcript }, acct.account_token);
  const beto = generateKeys();
  const j = await post(`/join/${room.join_code}`, { public_key: beto.public_key, accepts_terms_hash: room.rules_hash, display_name: "Beto", avatar: { voice: { rate: 1.1 } },
    sig: signValue(codeJoinPayload(room.room_id, room.join_code, beto.public_key, room.rules_hash), beto.private_key) });
  const say = await post(`/rooms/${room.room_id}/messages`, signOpen({ room_id: room.room_id, from: j.participant_id, type: "say", body: { text: "Hola desde Beto" } }, beto.private_key), j.participant_token);
  const prop = await post(`/rooms/${room.room_id}/messages`, signOpen({ room_id: room.room_id, from: j.participant_id, type: "propose", body: { text: "Cenamos el viernes" } }, beto.private_key), j.participant_token);
  return { room: room.room_id as string, seq: say.seq as number, proposalSeq: prop.seq as number };
}

test("sin ELEVENLABS_API_KEY la voz del server está apagada y la vista usa la del navegador", async () => {
  const base = await boot({});
  const { room, seq } = await roomWithMessage(base, true);
  const r = await fetch(`${base}/rooms/${room}/speech/${seq}`);
  assert.equal(r.status, 404);
  assert.equal((await r.json() as any).error, "tts_disabled");
});

test("con key: lee el mensaje del log, manda la key solo a ElevenLabs y cobra cada mensaje una vez", async () => {
  const base = await boot({ ELEVENLABS_API_KEY: "sk-test", ELEVENLABS_VOICES: "voz1,voz2", ELEVENLABS_BASE: STUB });
  const { room, seq, proposalSeq } = await roomWithMessage(base, true);
  calls.length = 0;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${base}/rooms/${room}/speech/${seq}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/mpeg");
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), "MP3DATA");
  }
  assert.equal(calls.length, 1, "la segunda vez sale de caché");
  assert.match(calls[0].url, /^\/v1\/text-to-speech\/voz[12]\?/);
  assert.equal(calls[0].key, "sk-test");
  assert.equal(calls[0].body.text, "Hola desde Beto");
  assert.equal(calls[0].body.voice_settings.speed, 1.1);

  // Solo mensajes say: un evento de entrada o un seq que no existe no se leen.
  assert.equal((await fetch(`${base}/rooms/${room}/speech/1`)).status, 404);
  assert.equal((await fetch(`${base}/rooms/${room}/speech/999`)).status, 404);
  assert.ok(proposalSeq > seq, "la propuesta quedó en el log");
  assert.equal((await fetch(`${base}/rooms/${room}/speech/${proposalSeq}`)).status, 404, "una propuesta tiene texto pero no es un say");
  assert.equal(calls.length, 1);

  // Cuarto sin transcript: el texto es solo de miembros, no se manda a un tercero.
  const priv = await roomWithMessage(base, false);
  assert.equal((await fetch(`${base}/rooms/${priv.room}/speech/${priv.seq}`)).status, 403);
  assert.equal(calls.length, 1);
});
