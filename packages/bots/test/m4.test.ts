// Los bots recorren el escenario del cumpleaños con el mismo cliente que usan Grok y Muse.
// (El criterio de cierre del M4 es con Grok y Muse reales; aquí Ana y Beto son bots suplentes.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario } from "../src/scenario.ts";

const PORT = 9100 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;

before(async () => {
  server = spawn(process.execPath, ["packages/server/src/index.ts"], { env: { ...process.env, PORT: String(PORT), DB_PATH: join(mkdtempSync(join(tmpdir(), "agentrooms-m4-")), "test.db"), ADMIN_TOKEN: "test-admin" }, stdio: "inherit" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/ping`)).ok) return; } catch { /* aún no arranca */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("el servidor no arrancó");
});
after(() => { server.kill(); });

test("cuatro delegados con el cliente cierran el cumpleaños en la Roma", async () => {
  const lines: string[] = [];
  const r = await runScenario({ base: BASE, admin: "test-admin", standIns: true, pollMs: 50, log: (l) => lines.push(l) });

  assert.equal(r.phase, "closed", lines.join("\n"));
  assert.equal(r.verify.ok, true);
  assert.deepEqual(r.log.options.map((o: any) => o.venue_id), ["v03", "v07", "v11"]);
  assert.equal(r.winner.venue_id, "v03", "todos aprueban las tres y gana la más barata");
  assert.equal(r.winner.zone, "roma");

  // Al cerrar, el acuerdo sale con fecha y datos listos para un calendario.
  const a = r.log.agreement;
  assert.equal(a.venue, "Fonda Inventada");
  assert.equal(new Date(`${a.date}T12:00:00Z`).getUTCDay(), 6, "la fecha cae en sábado");
  assert.ok(a.date > new Date().toISOString().slice(0, 10), "y es posterior a hoy");
  assert.equal(a.calendar.start, `${a.date}T19:00:00`);
  assert.equal(a.calendar.end, `${a.date}T21:00:00`);
  assert.match(a.confirmation, /^RES-/);
  assert.equal(a.attendees.length, 4);
  const ics = await (await fetch(`${BASE}/rooms/${r.room.room_id}/agreement.ics`)).text();
  assert.match(ics, /BEGIN:VEVENT[\s\S]*DTSTART;TZID=America\/Mexico_City:\d{8}T190000[\s\S]*LOCATION:Fonda Inventada\\, Roma/);

  // La instalación es un mensaje aparte, una sola vez por agente: el cliente, el mandato y el servidor MCP.
  const install = await (await fetch(r.room.install_url)).text();
  assert.match(install, /curl -fsS http:\/\/localhost:\d+\/agentroom\.mjs/);
  assert.match(install, /opciones: centro, condesa, juarez, polanco, roma/);
  assert.match(install, /claude mcp add agentroom -- node \$HOME\/\.agentroom\/agentroom\.mjs mcp/);
  assert.ok(!install.includes("/rooms/"), "la instalación no menciona ningún cuarto");

  // La entrada es solo el link: el agente ya instalado la hace con room_join.
  const msg = await (await fetch(r.room.invites[0].message_url)).text();
  assert.ok(msg.includes(`room_join`) && msg.includes(r.room.invites[0].url));
  assert.ok(!msg.includes("curl -fsS"), "la entrada no repite la instalación");
  assert.ok(!msg.includes("Lee las instrucciones en"), "no manda al agente a leer una página");

  const ev = r.log.events;
  // Todos entraron y actuaron firmando: son clientes como cualquier otro.
  assert.equal(ev.filter((e: any) => e.type === "join").length, 4);
  assert.ok(ev.filter((e: any) => e.from.startsWith("p_")).every((e: any) => e.signed));
  // Ana (la única con permiso) reservó; nadie más lo intentó en el servidor.
  const fulfill = ev.find((e: any) => e.type === "fulfill");
  assert.equal(fulfill.from, "p_grok");
  assert.match(fulfill.body.evidence.confirmation, /^RES-[A-Z0-9]{4}$/);
  assert.equal(ev.filter((e: any) => e.type === "rejected").length, 0);
  assert.equal(ev.filter((e: any) => e.type === "volunteer").length, 1);
});
