# Plan del core de compromisos: pasos 3 a 5

Fuente: plan del core multiplayer del 2026-11-21, pasos 3, 4 y 5. Parte de `packages/core` ya construido (contrato, gate, motor, outbox, harness).

## Restricciones generales

- El core se expone desde el servidor existente (`packages/server`, Hono + `node:sqlite`, Node 24, TS sin build) bajo rutas `/core/...`. No tocar las rutas ni tablas de cuartos existentes.
- `packages/core` sigue sin saber de HTTP ni SQLite. El servidor lo importa como `@agent-board/core` (agregar la dependencia en `packages/server/package.json` y exportar lo necesario desde `packages/core/package.json`).
- Persistencia por replay: el servidor guarda cada entrada que recibe el motor de un caso (eventos, lecturas, decisiones, revocaciones) con el `now` del servidor en que llegó, en una tabla de solo agregar. Para reconstruir un caso se crea un motor nuevo y se reaplican las entradas en orden con su `now` guardado. El motor es determinista, así que el estado sale igual.
- Hora: el servidor decide `now` (ISO UTC) al recibir. `created_at` del evento es informativo.
- Auth: tokens bearer por principal, como los `participant_token` actuales. Un token es de un caso y de un principal (`agent` o `person`). El servidor exige que `sender_id` del evento sea el agente del token; si no, 403 `sender_mismatch` y no llega al motor.
- Errores HTTP con la forma existente `{ error, message, hint }`. Un rechazo del motor responde 403 o 409 con `{ error: rule, message: reason, hint, rule_version }`.
- Pruebas con `node:test`, levantando el servidor con un `DB_PATH` temporal como `packages/server/test/m1.test.ts`. Correr con Node 26 (`PATH=/opt/homebrew/opt/node/bin:$PATH`).
- Sin dependencias nuevas. Llamadas salientes con `fetch` global inyectable para pruebas.
- Español en comentarios, mensajes y docs; sin emojis ni em dashes. Docs en el mismo cambio que el código: sección del core en `API.md`, estado en `README.md`.

## Decisiones de diseño

- Decisión: la aprobación humana deja de ser un dato que el agente afirma. Una persona registra una decisión por un canal autenticado (su token, desde la vista del caso). El `accept` del agente cita ese `decision_id` y el gate verifica que la decisión existe, la emitió el `approver_id`, aprueba, y su alcance (caso, tarea, recurso, oferta) es idéntico al del `accept`. Un `decision_id` inventado o de otra persona se rechaza con `approval`.
- Decisión: la revocación es una entrada del motor (`engine.revoke(agent_id, at)`) que fija `revoked_at` en su registro. Queda en el log de entradas y el replay la reaplica en su lugar.
- Decisión: el reemplazo de agente en este corte es rotación de credencial: el admin revoca el token viejo y emite uno nuevo para el mismo `agent_id`. Un traspaso a otro `agent_id` de la misma org cambia la regla `party` y queda para después. Si está mal: el gate del paso 3 queda cubierto a medias.
- Decisión: la entrega a agentes es por pull. `GET /core/cases/:id/inbox` devuelve las entregas pendientes del agente y las marca `delivered` en el outbox (acuse de entrega). El recibo de trabajo sigue siendo un evento `receipt`. Webhooks quedan para cuando un proveedor los pida.
- Decisión: MCP para el core queda fuera de este corte; los agentes usan HTTP con el `agent.md` del caso.
- Decisión: avisos a personas con un adaptador `notify` y dos implementaciones, Slack (`chat.postMessage`) y Kapso WhatsApp 1:1, activadas por variables de entorno. Si el aviso falla se reintenta y el caso no se pierde: la decisión vive en la vista, no en el chat.

---

### Tarea 1: Decisiones y revocación en el motor

Archivos: `packages/core/src/contract.ts`, `gate.ts`, `engine.ts`, `harness.ts`, sus pruebas, `README.md` del paquete.

- `Decision` humana en contrato: `HumanDecision = { decision_id, person_id, case_id, task_id, resource_id, offer_event_id, approve: boolean, conditions?: string (max 280), decided_at }` con esquema zod estricto. (Nombre distinto de `Decision` del gate.)
- `engine.decide(raw, now)`: parsea; rechaza con `approval` si la persona no existe, no tiene `may_approve`, no es de la org del requester del compromiso de esa tarea, la oferta citada no es la vigente, o el `decision_id` ya existe. Si pasa, guarda la decisión (mapa por `decision_id`) y la agrega a un log de decisiones. Devuelve `{ ok: true, decision }` o el rechazo, registrado en `rejections()`.
- Gate regla `approval` para `accept`: además de lo actual, la decisión `payload.decision_id` debe existir en `ctx.decisions`, con `person_id === payload.approver_id`, `approve === true`, y `case_id task_id resource_id offer_event_id` iguales al `scope` del `accept`. Mantener separación de funciones y el no reuso de `decision_id`.
- `engine.revoke(agent_id, at)`: fija `revoked_at` en el registro interno del motor; agente inexistente se rechaza. Devuelve `{ ok }`.
- `engine.decisions()` devuelve copias.
- Pendiente del paso 2: la regla `source_event` exige además que el evento origen sea de la misma tarea (`source.task_id === event.task_id`). Prueba: un `cancel` de la tarea B que cita un evento de la tarea A se rechaza con `source_event`.
- Escenario de referencia: agregar la decisión de `ana.ops` antes del `accept` (helper en `scenario.ts`, por ejemplo `decisions` exportado) y que `replay` del harness la aplique. Caso adversarial nuevo `fabricated_decision` (accept con `decision_id` que nadie registró) y `rejected_decision` (decisión con `approve: false`), ambos esperan `approval`. Los casos existentes de approval siguen en verde.
- TDD obligatorio.

### Tarea 2: Casos del core en el servidor

Archivos: `packages/server/src/core/store.ts` (tablas y replay), `packages/server/src/core/routes.ts` (rutas Hono), montaje en `packages/server/src/index.ts` (una línea), `packages/server/test/core.test.ts`, `API.md`.

- Tablas en la misma base: `core_cases(id, registry, created_at)`, `core_tokens(token, case_id, principal_id, kind)`, `core_inputs(case_id, seq, kind, body, now)` con `kind` en `event read decision revoke`.
- Cache de motores en memoria por caso; si no está, se reconstruye por replay desde `core_inputs`.
- Rutas:
  - `POST /core/cases` (admin): `{ case_id?, registry }` validado con el esquema `Registry`. Responde `201 { case_id, agents: [{ agent_id, token, agent_md_url }], people: [{ person_id, token, view_url }] }`.
  - `POST /core/cases/:id/events` (token de agente): el evento; exige `sender_id` igual al agente del token. Guarda la entrada solo si el motor la acepta o es duplicado. Responde `201 { ok, duplicate?, commitment }` o el rechazo.
  - `POST /core/cases/:id/evidence` (token de agente): evento `read_evidence`. Responde `{ evidence }` o rechazo.
  - `GET /core/cases/:id/inbox` (token de agente): entregas `pending` del agente con su evento; las marca `delivered` en el outbox y guarda el acuse como entrada para que el replay lo reproduzca (decidir la forma mínima, por ejemplo `kind: "ack"`).
  - `GET /core/cases/:id/state` (token de agente o persona del caso): compromisos del caso y decisiones; nunca contenido de evidencia.
  - `POST /core/cases/:id/revoke` (admin): `{ agent_id }`; aplica `engine.revoke` con `now` del servidor y guarda la entrada. También invalida los tokens de ese agente.
  - `POST /core/cases/:id/tokens` (admin): `{ agent_id }` emite un token nuevo para un agente no revocado e invalida los anteriores (rotación). Para un agente revocado responde 409.
- Cada caso tiene su propio motor y registro, así que un evento con `case_id` distinto al de la ruta se rechaza con 400 `case_mismatch` antes del motor. Esto cierra la toma de `case_id` ajenos que quedó pendiente en el paso 2.
- Pruebas: crear caso, correr el escenario LogisticsTech por HTTP de punta a punta hasta `verified`; `sender_mismatch`; token de otro caso 401; reinicio del servidor (matar y levantar con la misma base) conserva estado idéntico por replay; inbox marca entregas; revocar agente hace que su siguiente evento se rechace con `sender_valid` y que su token deje de servir.
- TDD obligatorio.

### Tarea 3: Vista del caso y decisiones humanas

Archivos: `packages/server/src/core/view.ts`, rutas en `packages/server/src/core/routes.ts`, pruebas en `packages/server/test/core.test.ts`.

- `GET /core/cases/:id/view?token=<token de persona>`: HTML accesible (HTML semántico, labels, foco visible, contraste, mismo estilo que `packages/server/src/web/view.ts`). Muestra por tarea: estado, oferta vigente exacta (event_id, remitente, recurso, tarea, versión de contrato, `created_at`, condiciones si hay), referencias de evidencia (ref y sha256, nunca contenido), y las decisiones ya tomadas. Si la persona puede aprobar y hay oferta vigente sin decisión, un formulario con condiciones opcionales y botones Aprobar y Rechazar.
- `POST /core/cases/:id/decisions` (token de persona, por header o campo de formulario): `{ task_id, offer_event_id, approve, conditions? }`. El servidor arma la decisión con `decision_id` nuevo, `person_id` del token y alcance tomado del compromiso, llama `engine.decide`, guarda la entrada. Responde JSON `{ decision }` o, si viene de formulario, redirige a la vista.
- Pruebas: vista con token de persona 200 y contiene la oferta vigente; sin token 401; decisión registrada y luego `accept` que la cita llega a `accepted`; decisión de persona sin `may_approve` rechazada; `accept` con `decision_id` inventado rechazado con `approval`.
- TDD obligatorio.

### Tarea 4: Avisos por Slack y WhatsApp (Kapso)

Archivos: `packages/server/src/core/notify.ts`, enganche en `routes.ts`, `packages/server/test/notify.test.ts`, `README.md` (variables de entorno).

- Antes de escribir el adaptador de Kapso, leer su documentación pública para enviar un mensaje de texto 1:1 por WhatsApp (endpoint, auth, body) y citarla en el reporte. No inventar endpoints: si no se puede confirmar, dejar Kapso detrás del mismo adaptador con el envío marcado como pendiente de verificar y reportarlo.
- Slack: `POST https://slack.com/api/chat.postMessage` con `Authorization: Bearer $SLACK_BOT_TOKEN` y `{ channel, text }`; tratar `ok: false` como fallo.
- Destinos por persona en el registro del caso: agregar al esquema `Person` un campo opcional `notify?: { channel: "slack" | "whatsapp", address: string }` (cambio en `packages/core/src/contract.ts`).
- Cuando el motor acepta un `offer` o `counteroffer`, el servidor encola un aviso para cada persona con `may_approve` de la org del requester que tenga `notify`: texto corto con la tarea, el recurso y el link a la vista. Cola en tabla `core_notifications(id, case_id, person_id, payload, attempts, status, last_error)` con reintentos (máximo 3) en el mismo request y en cada request posterior al caso. Un aviso fallido nunca bloquea ni revierte el evento.
- Sin variables de entorno, el canal está apagado y el aviso queda `skipped`.
- Pruebas con `fetch` falso: aviso Slack correcto (URL, header, body), fallo y reintento hasta `failed` con `last_error`, el evento queda aceptado igual, canal apagado da `skipped`.
- TDD obligatorio.

### Tarea 5: Dos agentes propios por HTTP y onboarding para agentes personales

Archivos: `packages/core/src/client.ts` (cliente HTTP mínimo del core, sin dependencias), `packages/server/src/core/agent-md.ts`, ruta `GET /core/cases/:id/agent.md?token=`, `packages/server/test/core-agents.test.ts`, `pruebas-manuales.md` (prueba P2), `README.md` (estado).

- `client.ts`: `coreClient(base, token)` con `send(event)`, `inbox()`, `state()`, `readEvidence(event)`. Usa `fetch`.
- Prueba e2e del paso 3: dos agentes guionizados (coordinador del almacén y rutas del transporte) usando `coreClient` contra el servidor real, con la persona aprobando por `POST /decisions`, recorren el escenario hasta `verified` leyendo su inbox para reaccionar (no se pasan ids a mano entre ellos: cada uno lee lo que le llega). Luego: revocar al agente de rutas a mitad de un segundo caso y verificar que su siguiente evento se rechaza.
- `agent.md` del caso: instrucciones en español para un agente sin contexto con la ruta `curl`: quién es, su caso, cómo leer inbox, cómo mandar cada kind que su rol permite (solo esos), qué no hacer (no inventar decisiones, no mandar evidencia en el chat). Mismo tono que `packages/server/src/onboarding/agent-md.ts`.
- `pruebas-manuales.md`: prueba P2 para dos agentes personales por separado, sin datos privados, con el checklist del gate del paso 4: emparejamiento (lee su agent.md), activación sin mensaje manual (registrar si el proveedor lo permite o no), respuesta, acuse, revocación, comportamiento con tarea detenida. Si un agente personal falla, anotar que el rol lo cubre un agente por API y que eso no prueba la integración personal.
- TDD obligatorio para `client.ts` y la ruta de `agent.md`.
