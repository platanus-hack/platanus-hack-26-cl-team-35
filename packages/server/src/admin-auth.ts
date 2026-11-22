// Tokens de servicio (admin y organizador): un solo lugar para leerlos y compararlos.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

// En local hay un token por defecto para probar. En producción no: sin ADMIN_TOKEN nadie es admin.
const PROD = process.env.NODE_ENV === "production";
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || (PROD ? "" : "dev-admin");
if (!process.env.ADMIN_TOKEN) {
  console.warn(PROD
    ? "ADMIN_TOKEN no definido en producción: las rutas de admin quedan cerradas hasta que lo definas."
    : "ADMIN_TOKEN no definido: usando 'dev-admin' (solo para local)");
}

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Compara dos secretos sin revelar por tiempo cuánto coinciden. */
export const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export const bearer = (c: Context) => c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
/** El request trae ese secreto como Bearer. Un secreto vacío nunca coincide. */
export const hasBearer = (c: Context, secret: string | undefined) => !!secret && sameSecret(bearer(c), secret);
export const isAdmin = (c: Context) => hasBearer(c, ADMIN_TOKEN);
