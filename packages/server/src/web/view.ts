import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const DINNER = read("./view.html"), CHAT = read("./chat.html"), VIEW3D = read("./view3d.html"), GLASSES = read("./glasses.html");
/** Renderer de los chibis, compartido por la vista del cuarto y la de los lentes. */
export const CHIBI_JS = read("./chibi.js");

/** Vista en vivo del cuarto: la de fases para una cena, la de chat para un cuarto abierto. */
export const viewHtml = (roomId: string, kind: "open" | "dinner" = "dinner"): string => (kind === "open" ? CHAT : DINNER).replaceAll("__ROOM_ID__", roomId);

/** Vista 3D del cuarto abierto, con KUBO para cada agente. */
export const view3dHtml = (roomId: string): string => VIEW3D.replaceAll("__ROOM_ID__", roomId);

/** Vista para lentes con pantalla (600x600, fondo negro): un mensaje a la vez, con voz. */
export const glassesHtml = (roomId: string): string => GLASSES.replaceAll("__ROOM_ID__", roomId);
