// Facilitador: cruza las restricciones con el catálogo y propone opciones.
// Determinista y sin LLM, para que el mismo escenario dé siempre el mismo resultado.
import { DAYS } from "@agent-board/protocol";
import type { Constraints, Option, Rules } from "@agent-board/protocol";

type Venue = Rules["venues"][number];
const DIMS = ["zones", "days", "budget", "diet", "music", "capacity"] as const;
export type Dimension = (typeof DIMS)[number];

/**
 * Pista para destrabar un cuarto sin opciones. Describe el catálogo, no a los participantes:
 * dice qué ofrecen los lugares que cumplen todo lo demás, nunca quién pidió qué.
 */
export type Hint = { dimension: Dimension; message: string } & Record<string, unknown>;
export type Blocked = { blocking: string; hints: Hint[]; message: string };

const later = (a: string, b: string) => (a > b ? a : b);
const DAY_ES: Record<string, string> = { mon: "lunes", tue: "martes", wed: "miércoles", thu: "jueves", fri: "viernes", sat: "sábado", sun: "domingo" };
const DIM_ES: Record<string, string> = { zones: "las zonas", days: "los días y horarios", budget: "el presupuesto", diet: "la dieta", music: "la música", capacity: "el cupo" };

/** El primer día de la semana que todos aceptan en ese lugar, a la hora más tardía que alguien pide. */
function slot(v: Venue, all: Constraints[]): { day: string; time: string } | null {
  for (const day of DAYS) {
    const open = v.days.find((d) => d.day === day);
    const mine = all.map((x) => x.days.find((d) => d.day === day));
    if (!open || mine.some((m) => !m)) continue;
    const time = mine.reduce((t, m) => later(t, m!.from ?? open.from), open.from);
    if (time < open.to) return { day, time };
  }
  return null;
}

function hintFor(dimension: Dimension, near: Venue[]): Hint {
  const uniq = <T>(xs: T[]) => [...new Set(xs)].sort();
  switch (dimension) {
    case "budget": {
      const min = Math.min(...near.map((v) => v.price_mxn));
      return { dimension, min_price_mxn: min, message: `El lugar más barato que cumple todo lo demás cuesta ${min} MXN por persona.` };
    }
    case "zones": {
      const zones = uniq(near.map((v) => v.zone));
      return { dimension, zones, message: `Hay lugares que cumplen todo lo demás en: ${zones.join(", ")}.` };
    }
    case "days": {
      const slots = uniq(near.flatMap((v) => v.days.map((d) => `${DAYS.indexOf(d.day)}|${d.day}|${d.from}|${d.to}`))).slice(0, 8).map((s) => {
        const [, day, from, to] = s.split("|");
        return { day, from, to };
      });
      return { dimension, slots, message: `Los lugares que cumplen todo lo demás abren: ${slots.map((s) => `${DAY_ES[s.day]} de ${s.from} a ${s.to}`).join("; ")}.` };
    }
    case "diet": {
      const diets = uniq(near.flatMap((v) => v.diets));
      return { dimension, diets, message: `Los lugares que cumplen todo lo demás ofrecen estas dietas: ${diets.join(", ") || "ninguna especial"}.` };
    }
    case "music":
      return { dimension, music: false, message: "Hay lugares que cumplen todo lo demás, pero no tienen música." };
    case "capacity": {
      const max = Math.max(...near.map((v) => v.capacity));
      return { dimension, max_capacity: max, message: `El lugar más grande que cumple todo lo demás es para ${max} personas.` };
    }
  }
}

/** Cruza las restricciones con el catálogo. Devuelve opciones, o qué bloquea y pistas para destrabarlo. */
export function computeOptions(rules: Rules, all: Constraints[], headcount: number): { options: Option[] } | Blocked {
  const minBudget = Math.min(...all.map((x) => x.budget_max_mxn));
  const checks: Record<Dimension, (v: Venue) => boolean> = {
    zones: (v) => all.every((x) => x.zones.includes("any") || x.zones.includes(v.zone)),
    days: (v) => slot(v, all) !== null,
    budget: (v) => v.price_mxn <= minBudget,
    diet: (v) => all.every((x) => x.diet.every((d) => v.diets.includes(d))),
    music: (v) => !all.some((x) => x.needs_music) || v.music,
    capacity: (v) => v.capacity >= headcount,
  };
  const ok = (v: Venue, except?: Dimension) => DIMS.every((d) => d === except || checks[d](v));

  const good = rules.venues.filter((v) => ok(v));
  if (good.length) {
    good.sort((a, b) => a.price_mxn - b.price_mxn || a.capacity - b.capacity || a.venue_id.localeCompare(b.venue_id));
    return {
      options: good.slice(0, rules.max_options).map((v, i) => {
        const s = slot(v, all)!;
        return { option_id: `o${i + 1}`, venue_id: v.venue_id, zone: v.zone, day: s.day, time: s.time, price_mxn: v.price_mxn };
      }),
    };
  }

  // Sin opciones. Para cada tipo de restricción: ¿habría lugares si solo esa cediera?
  const hints: Hint[] = [];
  for (const d of DIMS) {
    const near = rules.venues.filter((v) => ok(v, d));
    if (near.length) hints.push(hintFor(d, near));
  }
  if (hints.length) {
    return { blocking: hints[0].dimension, hints, message: `Ningún lugar cumple con todos. Bastaría con que cediera ${hints.map((h) => DIM_ES[h.dimension]).join(" o ")}. ${hints.map((h) => h.message).join(" ")}` };
  }
  // Ninguna restricción sola lo destraba: se reporta la primera que deja la lista vacía.
  let left = rules.venues;
  for (const d of DIMS) {
    left = left.filter(checks[d]);
    if (!left.length) return { blocking: d, hints: [], message: `Ningún lugar cumple con todos, y no basta con ceder en una sola cosa. Lo primero que bloquea es ${DIM_ES[d]}.` };
  }
  return { blocking: "capacity", hints: [], message: "Ningún lugar cumple con todos." };
}
