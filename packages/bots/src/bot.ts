// Un bot que sustituye a una persona en el cuarto.
// Usa el mismo cliente empaquetado que los agentes reales, como proceso aparte y con su propia carpeta:
// no tiene ningún acceso especial al servidor. Si un bot puede hacer algo, un agente real también.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(new URL("../../client/dist/agentroom.mjs", import.meta.url));

type Result = { code: number; out?: any; err?: any };
export type BotOptions = {
  /** Se ofrece a reservar si su mandato lo permite. */
  volunteers?: boolean;
  log?: (line: string) => void;
};

export class Bot {
  readonly name: string;
  readonly home: string;
  done = false;
  private volunteers: boolean;
  private log: (line: string) => void;
  private lastNote = "";

  constructor(name: string, mandate: object, opts: BotOptions = {}) {
    this.name = name;
    this.home = mkdtempSync(join(tmpdir(), `agentroom-bot-${name}-`));
    this.volunteers = opts.volunteers ?? false;
    this.log = opts.log ?? ((l) => console.log(l));
    const file = join(this.home, "mandato.json");
    writeFileSync(file, JSON.stringify(mandate));
    this.must("init", "--mandate", file);
  }

  /** Corre el cliente como lo haría un agente desde su terminal. */
  run(...args: string[]): Result {
    const r = spawnSync(process.execPath, [BUNDLE, ...args], { env: { ...process.env, AGENTROOM_HOME: this.home }, encoding: "utf8" });
    const parse = (s: string) => { try { return s ? JSON.parse(s) : undefined; } catch { return { raw: s }; } };
    return { code: r.status ?? 1, out: parse(r.stdout), err: parse(r.stderr) };
  }

  private must(...args: string[]) {
    const r = this.run(...args);
    if (r.code !== 0) throw new Error(`${this.name}: agentroom ${args[0]} falló: ${JSON.stringify(r.err)}`);
    return r.out;
  }

  private say(what: string) {
    if (what !== this.lastNote) this.log(`[${this.name}] ${what}`);
    this.lastNote = what;
  }

  private act(label: string, ...args: string[]): boolean {
    const r = this.run(...args);
    if (r.code === 0) { this.lastNote = ""; this.log(`[${this.name}] ${label} → fase ${r.out.phase}`); return true; }
    this.say(`${label}: ${r.err?.error} (${r.err?.message})`);
    return false;
  }

  join(inviteUrl: string) {
    const out = this.must("join", inviteUrl);
    this.log(`[${this.name}] entró como ${out.participant_id}`);
  }

  /** Un turno: mira el estado y hace lo que toca, igual que un agente al que le dicen "revisa el cuarto". */
  step(): string {
    // Si el servidor no responde (un despliegue, un corte de red), el bot espera al siguiente turno.
    const r = this.run("status");
    if (r.code !== 0) { this.say(`no pudo leer el estado: ${r.err?.error ?? "error"}`); return "unknown"; }
    const st = r.out;
    if (st.phase === "closed" || st.phase === "failed") { this.done = true; return st.phase; }

    if (st.phase === "constraints" && !st.you.submitted_constraints) this.act("mandó sus restricciones", "constraints");

    if (st.phase === "voting" && !st.you.voted) {
      const fits = st.options.filter((o: any) => o.fits_mandate).map((o: any) => o.option_id);
      if (fits.length) this.act(`aprobó ${fits.join(", ")}`, "vote", ...fits);
      else this.say("ninguna opción cabe en su mandato; no vota");
    }

    if (st.phase === "commitments") {
      for (const c of st.your_commitments) {
        if (c.state === "assigned") {
          // Intenta aceptar; si el mandato no lo permite, el cliente lo frena y el bot rechaza.
          if (!this.act(`aceptó ${c.commitment_id}`, "commit", c.commitment_id)) this.act(`rechazó ${c.commitment_id}`, "commit", c.commitment_id, "--decline");
        } else if (c.task === "reserve" && c.state === "accepted") {
          // La "persona" del bot hace la reserva simulada y le da el código.
          const code = "RES-" + Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
          this.act(`entregó la reserva ${code}`, "fulfill", c.commitment_id, "--confirmation", code);
        }
      }
      if (this.volunteers && st.reserve?.state === "open") this.act("se ofreció a reservar", "volunteer", "reserve");
    }
    return st.phase;
  }
}
