// Vista HTML del caso para personas: oferta vigente, evidencia por referencia y decisión humana.
import { NOTE_MAX } from "@agent-board/core";
import type { Commitment, Event, HumanDecision, Registry } from "@agent-board/core";

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
  :root { --bg:#fafaf7; --fg:#1c1c1a; --muted:#5f5f5a; --line:#d9d8d1; --card:#fff; --acc:#9a4412; --ok:#2e7d4f; --bad:#b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161614; --fg:#ecebe6; --muted:#a8a7a1; --line:#3a3936; --card:#1f1f1c; --acc:#f0a36b; --ok:#7fcf9f; --bad:#f2998f; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 8px; } h3 { font-size:14px; margin:12px 0 4px; }
  .meta { color:var(--muted); font-size:13px; margin-bottom:16px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:16px; }
  .state { font-weight:600; color:var(--acc); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; margin:0; font-size:13px; }
  dt { color:var(--muted); } dd { margin:0; overflow-wrap:anywhere; }
  code { font:12px ui-monospace, monospace; }
  ul { margin:4px 0; padding-left:20px; font-size:13px; }
  label { display:block; font-size:13px; margin:8px 0 2px; }
  input[type=text] { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font:inherit; }
  fieldset { border:0; padding:0; margin:0; } legend { font-weight:600; font-size:14px; padding:0; }
  button { padding:6px 14px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font:inherit; cursor:pointer; margin:8px 8px 0 0; }
  button.ok { border-color:var(--ok); color:var(--ok); } button.no { border-color:var(--bad); color:var(--bad); }
  :focus-visible { outline:2px solid var(--acc); outline-offset:2px; }
  .yes { color:var(--ok); } .nope { color:var(--bad); }
`;

type Input = { caseId: string; token: string; person: { person_id: string; org_id: string; may_approve: boolean }; registry: Registry; commitments: Commitment[]; log: Event[]; decisions: HumanDecision[] };

export function caseViewHtml(i: Input): string {
  const org = (agentId: string) => i.registry.agents.find((a) => a.agent_id === agentId)?.org_id;
  // Solo tareas donde la org de la persona es parte: un tercero del registro no ve ofertas ni evidencia ajenas.
  const tasks = i.commitments.filter((k) => [org(k.requester_id), org(k.provider_id)].includes(i.person.org_id)).map((k) => {
    const offer = i.log.find((e) => e.event_id === k.current_offer_event_id);
    const delivered = i.log.find((e) => e.event_id === k.delivered_event_id);
    const evidence = delivered && delivered.kind === "deliver" ? delivered.payload.evidence : [];
    const mine = i.decisions.filter((d) => d.task_id === k.task_id);
    const decidedOffer = mine.some((d) => d.offer_event_id === k.current_offer_event_id);
    const canDecide = i.person.may_approve && i.person.org_id === org(k.requester_id) && k.state === "offered" && offer && !decidedOffer;
    return `<section aria-labelledby="t-${esc(k.task_id)}">
  <h2 id="t-${esc(k.task_id)}">Tarea ${esc(k.task_id)}</h2>
  <p>Estado: <span class="state">${esc(k.state)}</span></p>
  ${offer ? `<h3>Oferta vigente</h3>
  <dl><dt>event_id</dt><dd><code>${esc(offer.event_id)}</code></dd><dt>Remitente</dt><dd>${esc(offer.sender_id)}</dd><dt>Recurso</dt><dd>${esc(offer.resource_id)}</dd>
  <dt>Tarea</dt><dd>${esc(offer.task_id)}</dd><dt>Contrato</dt><dd>${esc(offer.contract_version)}</dd><dt>Creada</dt><dd>${esc(offer.created_at)}</dd>${offer.note ? `<dt>Notas del proveedor</dt><dd>${esc(offer.note)}</dd>` : ""}</dl>` : "<p>Sin oferta vigente.</p>"}
  ${evidence.length ? `<h3>Evidencia entregada</h3><ul>${evidence.map((e) => `<li><code>${esc(e.ref)}</code> sha256 <code>${esc(e.sha256)}</code></li>`).join("")}</ul>` : ""}
  <h3>Decisiones</h3>
  ${mine.length ? `<ul>${mine.map((d) => `<li><span class="${d.approve ? "yes" : "nope"}">${d.approve ? "Aprobó" : "Rechazó"}</span> ${esc(d.person_id)} sobre <code>${esc(d.offer_event_id)}</code> el ${esc(d.decided_at)}${d.conditions ? `. Condiciones: ${esc(d.conditions)}` : ""} (<code>${esc(d.decision_id)}</code>)</li>`).join("")}</ul>` : "<p>Ninguna todavía.</p>"}
  ${canDecide ? `<form method="post" action="/core/cases/${esc(i.caseId)}/decisions"><fieldset><legend>Decidir sobre la tarea ${esc(k.task_id)}</legend>
    <input type="hidden" name="token" value="${esc(i.token)}"><input type="hidden" name="task_id" value="${esc(k.task_id)}"><input type="hidden" name="offer_event_id" value="${esc(offer.event_id)}">
    <label for="c-${esc(k.task_id)}">Condiciones (opcional)</label><input type="text" id="c-${esc(k.task_id)}" name="conditions" maxlength="${NOTE_MAX}">
    <button class="ok" type="submit" name="approve" value="true">Aprobar</button><button class="no" type="submit" name="approve" value="false">Rechazar</button>
  </fieldset></form>` : ""}
</section>`;
  }).join("\n");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Caso ${esc(i.caseId)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>Caso ${esc(i.caseId)}</h1>
  <p class="meta">Entraste como ${esc(i.person.person_id)}${i.person.may_approve ? "" : " (sin permiso para aprobar)"}</p>
  ${tasks || "<p>Este caso todavía no tiene tareas.</p>"}
</main>
</body>
</html>`;
}
