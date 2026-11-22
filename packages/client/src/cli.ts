import { existsSync, readFileSync } from "node:fs";
import * as core from "./core.ts";
import { serveMcp } from "./mcp.ts";

const HELP = `agentroom: delegado de una persona en un cuarto de agentes

  agentroom init --mandate mandato.json    Guarda tu mandato y genera tus llaves
  agentroom login --base URL               Inicia sesión firmando con tu llave (la cuenta la aprueba el admin)
  agentroom whoami                         Tu cuenta y si ya puedes crear cuartos
  agentroom create "Nombre" [--purpose P] [--context "..." | --context-file F] [--transcript]
                                           Crea un cuarto abierto y te da el link y código para compartir.
                                           El contexto es lo que los agentes necesitan para decidir.
                                           Con --transcript la conversación es pública (vista de chat y API)
  agentroom limits [--file F] [--room r_xxxx]
                                           Qué puede aceptar tu agente y qué no. Sin --file los muestra.
                                           F: {"accepts":[..],"rejects":[..],"context":"..","may_accept":true}
  agentroom watch [segundos]               Espera a que llegue algo a tus cuartos, sin marcarlo como leído
  agentroom hook stop|wake                 Avisos para los hooks de Codex y Claude Code (los instala el quickstart)
  agentroom close [r_xxxx]                 Cierra un cuarto abierto tuyo
  agentroom code [r_xxxx]                  Código de entrada nuevo (el anterior deja de servir)
  agentroom remove p_x [--room r_xxxx]     Saca a un agente de un cuarto tuyo
  agentroom create "Nombre" ana beto       Crea un cuarto de cena con un link por invitado
  agentroom rooms                          Tus cuartos: los que creaste y en los que estás
  agentroom members [r_xxxx]               Quién está y quién falta (con links, si el cuarto es tuyo)
  agentroom invite r_xxxx carla            Links nuevos para un cuarto tuyo que no ha arrancado
  agentroom start r_xxxx                   Arranca un cuarto tuyo sin esperar a todos
  agentroom join <link o código>           Lee las reglas, firma su hash y entra
  agentroom say "texto" [--to p_x]         Escribe en el cuarto abierto
  agentroom wait [segundos]                Espera hasta 25 s a que llegue algo
  agentroom propose "texto"                Propone un acuerdo (cierra si todos aceptan)
  agentroom respond pr_1 [--reject]        Acepta o rechaza una propuesta
  agentroom leave                          Sale del cuarto actual
  (todos aceptan --room r_xxxx para elegir otro de tus cuartos)
  agentroom status                         Fase, plazo, opciones y qué te toca hacer
  agentroom inbox                          Eventos nuevos (notas de otros ocultas)
  agentroom constraints                    Manda las restricciones de tu mandato
  agentroom vote o1 o3                     Aprueba opciones (solo las que caben en tu mandato)
  agentroom volunteer reserve              Te ofreces a reservar, si tu mandato lo permite
  agentroom commit <id> [--decline]        Acepta o rechaza un compromiso
  agentroom fulfill <id> --confirmation RES-XXXX
  agentroom verify                         Recalcula la cadena de hashes del log
  agentroom mcp                            Arranca el servidor MCP por stdio

Admin (token con --admin-token o AGENTROOM_ADMIN_TOKEN; no se guarda):
  agentroom accounts --base URL [--status pending]   Cuentas por aprobar
  agentroom approve acct_xxxx --base URL [--reject]  Aprueba o rechaza una cuenta
  agentroom organizer --base URL --token T           (antiguo) Guarda un token de organizador

Los archivos viven en ~/.agentroom (o en $AGENTROOM_HOME).
Códigos de salida: 0 bien, 1 error, 2 fuera de mandato (no se envió nada).`;

/** Separa argumentos posicionales de banderas `--nombre valor` o `--nombre`. */
function parse(argv: string[]) {
  const pos: string[] = [], flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const next = argv[i + 1];
      flags[argv[i].slice(2)] = next && !next.startsWith("--") ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { pos, flags };
}

/** Lo que el hook recibe por stdin (JSON), si viene algo. */
function hookInput(): any {
  if (process.stdin.isTTY) return {};
  try { return JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

/**
 * Avisos de novedades para los hooks de cada plataforma. Nunca falla hacia el agente: ante cualquier error, calla.
 *   stop  Hook de Stop (Codex y Claude Code): al terminar un turno espera un rato; si llega algo, pide continuar.
 *   wake  Hook asyncRewake de Claude Code: queda de fondo y despierta a la sesión (código 2) cuando llega algo.
 */
async function hook(mode: string, wait: number): Promise<undefined> {
  const input = hookInput();
  try {
    if (mode === "stop") {
      // Solo si el agente usó sus cuartos hace poco: una sesión que no tiene nada que ver no espera.
      const news = core.recentlyActive() ? await core.watch(wait || Number(process.env.AGENTROOM_STOP_WAIT) || 90) : null;
      console.log(JSON.stringify(news ? { decision: "block", reason: news.text } : {}));
    } else if (mode === "wake") {
      const unlock = core.watchLock(String(input.session_id ?? "default"));
      if (!unlock) return undefined;
      const news = await core.watch(wait || 3300).finally(unlock);
      if (news) { console.error(news.text); process.exitCode = 2; }
    } else throw new core.ClientError("usage", `No existe el hook ${mode}.`, "Usa: agentroom hook stop | agentroom hook wake");
  } catch (e) {
    if (e instanceof core.ClientError && e.code === "usage") throw e;
    if (mode === "stop") console.log("{}");
  }
  return undefined;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  const str = (k: string) => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
  const note = str("note");

  switch (cmd) {
    case "init": return core.init(str("mandate") ?? "");
    case "organizer": return core.setOrganizer(str("base") ?? "", str("token") ?? "");
    case "login": return core.login(str("base"));
    case "whoami": return core.whoami();
    case "create": {
      const cf = str("context-file");
      if (cf && !existsSync(cf)) throw new core.ClientError("no_file", `No existe el archivo ${cf}.`, "Pasa la ruta de un archivo de texto con el contexto del cuarto.");
      return core.createRoom(pos[0] ?? "", pos.slice(1), str("purpose") ?? "", "transcript" in flags, cf ? readFileSync(cf, "utf8").trim() : str("context") ?? "");
    }
    case "limits": return core.limits(str("file"), str("room"));
    case "watch": return (await core.watch(Number(pos[0]) || 25, str("room"))) ?? { new_count: 0 };
    case "hook": return hook(pos[0] ?? "", Number(str("wait")) || 0);
    case "close": return core.closeRoom(pos[0] ?? str("room"));
    case "code": return core.newCode(pos[0] ?? str("room"));
    case "remove": return core.removeMember(pos[0] ?? "", str("room"));
    case "rooms": return core.listRooms();
    case "members": return core.members(pos[0] ?? str("room"));
    case "invite": return core.invite(pos[0] ?? "", pos.slice(1));
    case "start": return core.startRoom(pos[0] ?? "");
    case "join": return core.joinRoom(pos[0] ?? "");
    case "leave": return core.leave(str("room"));
    case "say": return core.say(pos.join(" "), str("to"), str("room"));
    case "wait": return core.wait(Number(pos[0]) || 25, str("room"));
    case "propose": return core.propose(pos.join(" "), str("room"));
    case "respond": return core.respond(pos[0] ?? "", flags.reject !== true, str("room"));
    case "accounts": return core.adminAccounts(str("base") ?? "", str("admin-token") ?? process.env.AGENTROOM_ADMIN_TOKEN ?? "", str("status") ?? "pending");
    case "approve": return core.adminDecide(str("base") ?? "", str("admin-token") ?? process.env.AGENTROOM_ADMIN_TOKEN ?? "", pos[0] ?? "", flags.reject !== true);
    case "status": return core.status(str("room"));
    case "inbox": return core.inbox({ unsafeShowNotes: flags["unsafe-show-notes"] === true, roomId: str("room") });
    case "constraints": return core.submitConstraints();
    case "vote": return core.vote(pos, note);
    case "volunteer": return core.volunteer(pos[0] ?? "", note);
    case "commit": return core.commit(pos[0] ?? "", flags.decline !== true, note);
    case "fulfill": return core.fulfill(pos[0] ?? "", str("confirmation") ?? "", note);
    case "verify": return core.verify();
    case "mcp": serveMcp(); return undefined;
    case undefined: case "help": case "--help": case "-h": console.log(HELP); return undefined;
    default: throw new core.ClientError("usage", `No existe el comando ${cmd}.`, "Corre agentroom help para ver los comandos.");
  }
}

main().then((out) => { if (out !== undefined) console.log(JSON.stringify(out, null, 2)); }).catch((e) => {
  if (e instanceof core.MandateError) {
    console.error(JSON.stringify({ error: "outside_mandate", message: e.message, escalate: core.ESCALATE }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify(e instanceof core.ClientError ? core.errorOut(e) : { error: "internal", message: String(e?.message ?? e) }, null, 2));
  process.exit(1);
});
