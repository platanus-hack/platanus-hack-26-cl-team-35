// Escenario del cumpleaños: crea el cuarto, imprime los links de Ana y Beto,
// y corre los bots Carla y Diego hasta que el cuarto termine.
//
//   node packages/bots/src/scenario.ts --base https://servidor --admin TOKEN
//   node packages/bots/src/scenario.ts --base http://localhost:8787 --stand-ins   (Ana y Beto también son bots)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bot } from "./bot.ts";

export const PERSONAS = JSON.parse(readFileSync(fileURLToPath(new URL("../personas.json", import.meta.url)), "utf8"));

export type ScenarioOptions = {
  base: string;
  admin: string;
  /** Ana y Beto como bots, para probar sin agentes reales. */
  standIns?: boolean;
  /** Plazo de cada fase en segundos. */
  deadlines?: Record<string, number>;
  pollMs?: number;
  log?: (line: string) => void;
  /** Archivo donde guardar la respuesta de creación del cuarto (con los links). */
  save?: string;
};

export async function runScenario(o: ScenarioOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const res = await fetch(`${o.base}/rooms`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.admin}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Cumpleaños de Diego",
      invites: ["ana", "beto", "carla", "diego"],
      rules: { honoree: "diego", deadlines: o.deadlines ?? { open: 7200, constraints: 1800, voting: 1800, commitments: 1800 } },
    }),
  });
  if (!res.ok) throw new Error(`No se pudo crear el cuarto: ${res.status} ${await res.text()}`);
  const room = (await res.json()) as { room_id: string; view_url: string; invites: { label: string; url: string; message_url: string }[] };
  if (o.save) writeFileSync(o.save, JSON.stringify(room, null, 2) + "\n");
  const link = (label: string) => room.invites.find((i) => i.label === label)!.url;

  log(`Cuarto ${room.room_id} · vista: ${room.view_url}`);
  log(`Link para Ana:  ${link("ana")}`);
  log(`Link para Beto: ${link("beto")}`);

  const bots = [new Bot("carla", PERSONAS.carla, { log }), new Bot("diego", PERSONAS.diego, { log })];
  bots[0].join(link("carla"));
  bots[1].join(link("diego"));
  if (o.standIns) {
    const ana = new Bot("ana", PERSONAS.ana, { log, volunteers: true }), beto = new Bot("beto", PERSONAS.beto, { log });
    ana.join(link("ana"));
    beto.join(link("beto"));
    bots.push(ana, beto);
  }

  const started = Date.now();
  let phase = "open";
  while (bots.some((b) => !b.done)) {
    for (const b of bots) if (!b.done) phase = b.step();
    await new Promise((r) => setTimeout(r, o.pollMs ?? 3000));
  }
  const final = (await (await fetch(`${o.base}/rooms/${room.room_id}/log`)).json()) as any;
  const verify = (await (await fetch(`${o.base}/rooms/${room.room_id}/log/verify`)).json()) as any;
  const firstJoin = final.events.find((e: any) => e.type === "join")?.ts;
  const end = final.events.at(-1).ts;
  log(`Terminó en ${final.phase} · ganador: ${final.winner?.venue_id ?? "ninguno"} · ${final.events.length} eventos · log ${verify.ok ? "íntegro" : "ALTERADO"}`);
  log(`Del primer join al cierre: ${Math.round((Date.parse(end) - Date.parse(firstJoin)) / 1000)} s · bots corriendo ${Math.round((Date.now() - started) / 1000)} s`);
  return { room, phase: final.phase as string, winner: final.winner, log: final, verify };
}

// Ejecución directa desde la terminal.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const r = await runScenario({
    base: (arg("base") ?? process.env.BASE ?? "http://localhost:8787").replace(/\/$/, ""),
    admin: arg("admin") ?? process.env.ADMIN_TOKEN ?? "dev-admin",
    standIns: process.argv.includes("--stand-ins"),
    save: arg("save"),
  });
  process.exit(r.phase === "closed" ? 0 : 1);
}
