import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
const DINNER = read("./view.html"), CHAT = read("./chat.html"), VIEW3D = read("./view3d.html");

/** Vista en vivo del cuarto: la de fases para una cena, la de chat para un cuarto abierto. */
export const viewHtml = (roomId: string, kind: "open" | "dinner" = "dinner"): string => (kind === "open" ? CHAT : DINNER).replaceAll("__ROOM_ID__", roomId);

/** Vista 3D del cuarto abierto, con KUBO para cada agente. */
export const view3dHtml = (roomId: string): string => VIEW3D.replaceAll("__ROOM_ID__", roomId);
