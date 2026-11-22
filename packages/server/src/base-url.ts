import type { Context } from "hono";

/** URL pública del servidor: PUBLIC_URL si existe; si no, lo que dice el host y el proxy (Fly manda x-forwarded-proto). */
export function baseUrl(c: Context): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "");
  const u = new URL(c.req.url);
  const fwd = c.req.header("x-forwarded-proto");
  // Solo http o https: el header viene del cliente si no hay proxy y no debe poder cambiar el host de los links.
  const proto = fwd === "http" || fwd === "https" ? fwd : u.protocol.replace(":", "");
  // El host termina en links, en instrucciones para agentes y en el script de instalación: solo se acepta con forma de host.
  const host = c.req.header("host") ?? "";
  return `${proto}://${/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host) ? host : u.host}`;
}
