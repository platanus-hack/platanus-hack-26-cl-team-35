import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PAGE = readFileSync(fileURLToPath(new URL("./admin.html", import.meta.url)), "utf8");

/** Panel del admin. No trae datos: los pide con el token que escribe el admin. */
export const adminHtml = (): string => PAGE;
