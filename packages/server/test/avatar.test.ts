// Autorretrato del agente: el server solo guarda rasgos de una lista cerrada.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeJoinPayload, generateKeys, loginPayload, sanitizeAvatar, signValue } from "@agent-board/protocol";

test("sanitizeAvatar: conserva lo válido y descarta lo que no está en la lista", () => {
  const a = sanitizeAvatar({
    hair: "pink", eyes: "<script>", outfit: "hoodie", accessory: "headphones", mood: "happy", pet: "axolotl",
    palette: "#ff8fb1", voice: { pitch: 1.4, rate: 9, lang: "es-MX" }, bio: "organizo\ncenas <b>", name: "  Lumen\n", extra: "x",
  });
  assert.deepEqual(a, {
    hair: "pink", outfit: "hoodie", accessory: "headphones", mood: "happy", pet: "axolotl",
    palette: "#ff8fb1", voice: { pitch: 1.4, lang: "es-MX" }, bio: "organizo cenas <b>", name: "Lumen",
  });
  assert.equal(sanitizeAvatar({ name: "x".repeat(99) })!.name!.length, 24);
  assert.equal(sanitizeAvatar({ palette: "red;background:url(x)" }), null);
  assert.equal(sanitizeAvatar({ voice: { lang: "es\"><svg" } }), null);
  assert.equal(sanitizeAvatar("hoodie"), null);
  assert.equal(sanitizeAvatar(null), null);
  assert.equal(sanitizeAvatar({ hair: "__proto__" }), null);
  assert.equal(sanitizeAvatar({ bio: "x".repeat(500) })!.bio!.length, 80);
});

const TMP = mkdtempSync(join(tmpdir(), "agentrooms-avatar-"));
let server: ChildProcess, BASE = "";
before(async () => {
  const port = 8800 + Math.floor(Math.random() * 500);
  BASE = `http://localhost:${port}`;
  const { ADMIN_TOKEN: _a, NODE_ENV: _n, ...clean } = process.env;
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...clean, PORT: String(port), DB_PATH: join(TMP, "a.db"), ADMIN_TOKEN: "t", OPEN_SIGNUP: "1" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
});
after(() => server?.kill());

const post = async (path: string, body: unknown, token?: string) =>
  (await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json() as any;

test("join con avatar: queda saneado en members y en el evento de entrada", async () => {
  const k = generateKeys(), ts = new Date().toISOString();
  const acct = await post("/accounts/login", { public_key: k.public_key, display_name: "Ana", ts, sig: signValue(loginPayload(k.public_key, "Ana", ts), k.private_key) });
  const made = await post("/rooms", { kind: "open", name: "Chibis", avatar: { hair: "blue" } }, acct.account_token);

  const beto = generateKeys();
  const j = await post(`/join/${made.join_code}`, {
    public_key: beto.public_key, accepts_terms_hash: made.rules_hash, display_name: "Beto",
    sig: signValue(codeJoinPayload(made.room_id, made.join_code, beto.public_key, made.rules_hash), beto.private_key),
    avatar: { hair: "pink", pet: "<img src=x onerror=alert(1)>", palette: "#00ff00" },
  });
  assert.ok(j.participant_id, JSON.stringify(j));

  const log = await (await fetch(`${BASE}/rooms/${made.room_id}/log`)).json() as any;
  const byId = Object.fromEntries(log.participants.map((p: any) => [p.participant_id, p.avatar]));
  assert.deepEqual(byId[made.participant_id], { hair: "blue" });
  assert.deepEqual(byId[j.participant_id], { hair: "pink", palette: "#00ff00" });
  assert.ok(!JSON.stringify(log).includes("onerror"));
});
