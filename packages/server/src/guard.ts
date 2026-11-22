// Límites por IP: de dónde sale la IP del cliente, cuántas llamadas por minuto y cuántos flujos SSE abiertos.
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { checkRate } from "./supervisor.ts";

/** IP del cliente. Fly pisa fly-client-ip con la real; x-forwarded-for lo puede inventar cualquiera. */
export function clientIp(c: Context): string {
  const h = c.req.header("fly-client-ip");
  if (h) return h;
  try { return getConnInfo(c).remote.address ?? "unknown"; } catch { return "unknown"; }
}

export const LOGIN_PER_MIN = 10, ROOMS_PER_MIN = 10;

/** true si la IP ya pasó `limit` llamadas a `bucket` en el último minuto. */
export const overIpLimit = (c: Context, bucket: string, limit: number) => !checkRate(`ip:${bucket}`, clientIp(c), limit).ok;

export const SSE_PER_IP = 10;
const streams = new Map<string, number>();

/** Reserva un flujo SSE para la IP. Devuelve la función que lo libera (idempotente) o undefined si ya tiene SSE_PER_IP. */
export function streamSlot(ip: string): (() => void) | undefined {
  const n = streams.get(ip) ?? 0;
  if (n >= SSE_PER_IP) return undefined;
  streams.set(ip, n + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (streams.get(ip) ?? 1) - 1;
    if (left > 0) streams.set(ip, left); else streams.delete(ip);
  };
}
