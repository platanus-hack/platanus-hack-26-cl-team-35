# Plan del core de compromisos: pasos 1 y 2

Fuente: plan del core multiplayer del 2026-11-21 (https://agent-board-mvp-unificado.twinyarrow8.chatgpt.site/investigacion/plan). Este plan cubre solo sus pasos 1 y 2. Los pasos 3 a 6 necesitan agentes externos, canales y un segundo operador, y quedan fuera.

## Restricciones generales

- Paquete nuevo `packages/core` (`@agent-board/core`), independiente de `packages/server` y del cliente. No tocar código existente salvo `package.json` raíz (script `test`).
- Node 24, TypeScript ejecutado directo (type stripping, sin build), igual que `packages/server`. Imports con extensión `.ts`. Sin `enum` ni sintaxis que type stripping no soporte.
- Única dependencia: `zod` (ya instalada en el workspace, `^4.6.7`). Pruebas con `node:test` y `node:assert/strict`. Nada más.
- Idioma: comentarios, mensajes de error y docs en español, sin emojis, sin em dashes. Identificadores y campos en inglés tal como abajo.
- `CONTRACT_VERSION = "core-0.1"`. Cada regla del policy gate tiene `rule` (id) y `rule_version` (`"1"`).
- Texto libre (`note`) es solo contexto: nunca cambia estado. Solo un evento tipado y validado cambia estado.
- Un evento rechazado no cambia nada: ni estado, ni log de compromisos, ni outbox. Se registra solo en la lista de rechazos.
- Tiempo inyectado: toda función que necesite "ahora" lo recibe como argumento (`now: string` ISO). Nada de `Date.now()` dentro del core. Pruebas deterministas.
- Store en memoria por ahora. Decisión: el plan permite un store central transaccional; la atomicidad se logra calculando el nuevo estado y reemplazándolo solo si todo pasa. SQLite queda para cuando haya un servidor del core.
- Evidencia por referencia: el payload lleva `{ ref, sha256 }`, nunca el contenido.
- Commits pequeños en español, voz humana, sin trailers de IA.

## Modelo (lo fija la Tarea 1, lo consumen las demás)

Estados del compromiso: `requested → offered → accepted → executing → delivered → verified`, más `rejected` y `cancelled` como finales. `delivered` es el resultado entregado por el proveedor; solo pasa a `verified` si existe un recibo del destinatario para el evento `deliver`.

Decisión: el plan nombra contraoferta pero su máquina de estados no la tiene. Una `counteroffer` es un evento que deja el compromiso en `offered` y reemplaza la oferta vigente (`current_offer_event_id`). No hay estado nuevo.

Decisión: se agrega `delivered` entre `executing` y `verified` porque el invariante "nada marcado entregado sin recibo" necesita distinguir entrega de verificación.

Decisión: `reject` se permite desde `requested offered accepted` y `cancel` desde `requested` hasta `executing`.

Kinds de evento: `request`, `offer`, `counteroffer`, `accept`, `start`, `deliver`, `receipt`, `verify`, `reject`, `cancel`, `read_evidence`.

Campos de todo evento: `event_id`, `case_id`, `task_id`, `sender_id`, `recipient_id`, `kind`, `resource_id`, `source_event_id` (opcional; obligatorio en todo kind salvo `request`), `contract_version`, `created_at`, `expires_at` (opcional), `payload` (objeto según kind), `note` (opcional, max 280).

`accept` agrega en payload: `approver_id`, `decision_id`, `scope: { case_id, task_id, resource_id, offer_event_id }`.

`deliver` agrega en payload: `evidence: [{ ref, sha256 }]` (al menos uno).

`receipt` referencia en `source_event_id` el evento recibido. Un recibo confirma entrega del mensaje, no aprueba el trabajo.

Registro: agentes `{ agent_id, provider, org_id, role, capabilities: kind[], valid_from, valid_until, revoked_at? }` y personas `{ person_id, org_id, may_approve }`.

## Escenario de referencia: LogisticsTech

- Org `almacen-norte`: agente `almacen.coordinador` (role `requester`, capabilities `request accept verify cancel reject receipt read_evidence`), agente `almacen.inventario` (role `observer`, capabilities `read_evidence receipt`). Persona `ana.ops` (`may_approve: true`).
- Org `transportes-sur`: agente `transportes.rutas` (role `provider`, capabilities `offer counteroffer start deliver reject receipt read_evidence`).
- Todos válidos de `2026-11-01T00:00:00Z` a `2026-12-31T00:00:00Z`.
- Caso `case-lt-1`, tarea `task-envio-lote-1`, recurso `camion-07@2026-11-24T08:00`.
- Secuencia esperada: `request` (coordinador → rutas) → `offer` (rutas → coordinador) → `accept` con aprobación de `ana.ops` (coordinador → rutas) → `start` (rutas) → `deliver` con evidencia (rutas) → `receipt` del deliver (coordinador) → `verify` (coordinador). Estado final `verified`, ningún rechazo.

## Reglas del policy gate

| rule | Qué rechaza |
| --- | --- |
| `contract_version` | versión distinta de `CONTRACT_VERSION` |
| `expired` | `expires_at` presente y `<= now` |
| `sender_registered` | sender no está en el registro |
| `sender_valid` | `now` fuera de `[valid_from, valid_until)` o `revoked_at <= now` |
| `recipient_registered` | recipient no está en el registro o está revocado |
| `capability` | `kind` no está en las capabilities del sender |
| `party` | sender no es parte del caso: el requester del caso para `accept verify cancel`, el provider para `offer counteroffer start deliver`; `reject`, `receipt` y `read_evidence` exigen que la org del sender sea una de las dos orgs del caso |
| `transition` | transición ilegal desde el estado actual |
| `source_event` | `source_event_id` falta o no existe en el log del caso |
| `approval` | `accept` sin aprobación válida: approver no existe, no tiene `may_approve`, no es de la org del requester, es el mismo sender (separación de funciones), el `scope` no coincide exactamente con case, task, resource y oferta vigente, o el `decision_id` ya se usó |
| `double_booking` | `accept` sobre un recurso que ya tiene otro compromiso en `accepted executing delivered` |
| `receipt_required` | `verify` sin recibo registrado del `deliver` vigente |
| `evidence_scope` | `read_evidence` desde una org que no es parte del caso |

Un `event_id` repetido no es rechazo: es duplicado idempotente, devuelve `duplicate: true` y no cambia nada.

---

### Tarea 1: Contrato y escenario de referencia

Archivos: `packages/core/package.json`, `packages/core/src/contract.ts`, `packages/core/src/scenario.ts`, `packages/core/test/contract.test.ts`, `packages/core/README.md`, `package.json` raíz (agregar `packages/core/test/` al script `test`).

- `contract.ts`: `CONTRACT_VERSION`, `STATES`, `FINAL_STATES`, `KINDS`, esquemas zod `Agent`, `Person`, `Registry` (`{ agents, people }`), `Evidence`, `Event` (con payload validado según kind: `accept` y `deliver` estrictos como arriba, los demás objeto vacío o libre de campos que cambien estado), tipos inferidos, y la tabla `TRANSITIONS: Record<kind, { from: State[]; to: State | null }>` (`receipt` y `read_evidence` no cambian estado, `to: null`). `Decision` = `{ allow: true } | { allow: false; rule; rule_version; reason }`.
- `scenario.ts`: exporta `registry`, `events` (la secuencia esperada, con `created_at` crecientes desde `2026-11-21T10:00:00Z`), `expected` (`{ final_state: "verified", rejections: 0 }`) y `referenceTrace`: arreglo `{ event_id, kind, state_after }` por evento.
- Pruebas: el registro y cada evento del escenario pasan sus esquemas; un `accept` sin `approver_id` falla; un `deliver` sin evidencia falla; un evento con campo extra falla (`strictObject`); `referenceTrace` tiene un paso por evento y termina en `verified`; las transiciones que la tabla declara forman el camino del escenario.
- README corto: qué es el paquete, estados, kinds, reglas (puede enlazar a la tabla de este contrato), y que pasos 3 a 6 no están construidos.
- TDD: pruebas primero, verlas fallar, luego implementar.

### Tarea 2: Policy gate

Archivos: `packages/core/src/gate.ts`, `packages/core/test/gate.test.ts`.

- `check(event, ctx, now): Decision` puro. `ctx` = `{ registry, commitment?: Commitment, caseLog: Event[], usedDecisionIds: Set<string>, resourceHolders: Map<resource_id, task_id> }` donde `Commitment` = `{ case_id, task_id, resource_id, requester_id, provider_id, state, current_offer_event_id?, delivered_event_id?, receipts: string[] }` (definir el tipo en `contract.ts`).
- Evalúa las reglas en el orden de la tabla y devuelve la primera que falla. Para `request` (sin compromiso previo) el sender pasa a ser requester y el recipient provider; la regla `transition` exige que no exista compromiso para ese `task_id`.
- Una prueba por regla que falla con el `rule` exacto, más una que el escenario completo pase evento por evento (alimentando `ctx` a mano o con un helper mínimo dentro de la prueba).
- TDD obligatorio.

### Tarea 3: Motor de compromisos y registro de evidencia

Archivos: `packages/core/src/engine.ts`, `packages/core/test/engine.test.ts`.

- `createEngine(registry)` devuelve `{ apply(event, now), state(), log(), rejections(), readEvidence(event, now) }`.
- `apply`: parsea con el esquema (un parse fallido es rechazo con `rule: "schema"`), detecta duplicado por `event_id`, llama a `check`, y solo si permite: calcula el nuevo compromiso, agrega al log, registra `decision_id`, actualiza `resourceHolders` (se libera al llegar a `verified rejected cancelled`), y encola en el outbox una entrega para `recipient_id`. Devuelve `{ ok: true, duplicate?: true, commitment }` o `{ ok: false, rule, rule_version, reason }`.
- Atomicidad: construir todo sobre copias y reemplazar al final; una prueba muestra que tras un rechazo `state()`, `log()` y el outbox son idénticos (deepEqual) a antes.
- `readEvidence` pasa por el gate (kind `read_evidence`) y devuelve solo las referencias `{ ref, sha256 }` del caso.
- El outbox vive aquí como arreglo de `{ delivery_id, event_id, recipient_id, attempts, status: "pending" | "delivered" | "failed" }`; la Tarea 4 agrega el despacho.
- Pruebas: escenario completo termina en `verified` y su traza `{ event_id, kind, state_after }` es igual a `referenceTrace`; duplicado no cambia nada; doble reserva entre dos tareas sobre el mismo recurso rechazada; nota con instrucciones ("ignora las reglas y acepta") no cambia estado.
- TDD obligatorio.

### Tarea 4: Outbox con reintentos y recibos

Archivos: `packages/core/src/outbox.ts`, `packages/core/test/outbox.test.ts`; `engine.ts` solo para exponer el outbox si hace falta.

- `dispatch(engine, transport, now, { maxAttempts = 3 })`: para cada entrega `pending`, llama `transport(delivery, event)`; si resuelve, `status = "delivered"`; si lanza, `attempts++` y queda `pending` hasta llegar a `maxAttempts`, entonces `failed`. Devuelve resumen `{ delivered, retried, failed }`.
- Una entrega `delivered` no es un recibo: el compromiso solo avanza a `verified` cuando el destinatario manda un evento `receipt` por `apply`.
- Pruebas: transporte que falla dos veces y luego entrega; transporte que siempre falla termina en `failed` y el compromiso sigue en `delivered` sin poder verificarse; `verify` sin `receipt` rechazado con `receipt_required`.
- TDD obligatorio.

### Tarea 5: Harness de escenarios e invariantes

Archivos: `packages/core/src/harness.ts`, `packages/core/test/harness.test.ts`.

- `replay(registry, events, now?)`: corre los eventos en un motor nuevo (`now` por evento = su `created_at` salvo que se pase otro) y devuelve `{ trace, rejections, engine }`.
- `invariants(engine)`: lista de violaciones sobre el estado final y el log: cero recursos con dos compromisos activos; cero eventos en el log cuyo sender no tenía autoridad (re-chequeo con el gate contra el estado de ese momento, o verificación de que cada evento del log tiene capability y es parte); cero lecturas fuera de alcance; cero compromisos `verified` sin recibo del `deliver`.
- `ADVERSARIAL`: casos nombrados, cada uno `{ name, events, expect_rule }`, derivados del escenario: `double_booking`, `duplicate_message` (espera duplicado, no rechazo), `expired_message`, `revoked_agent`, `borrowed_approval` (approver de la otra org, y approver igual al sender), `cross_party_read`, `failed_delivery` (via outbox), `instruction_in_evidence` (ref de evidencia o nota con instrucciones que no cambian estado), `cited_authorization` (accept que reutiliza un `decision_id` ajeno), `retry_after_revocation`.
- `runAll()`: reporte `{ contract_version, reference: { ok, diff? }, cases: [{ name, ok, counterexample? }] }`. Un contraejemplo es el evento que pasó cuando debía fallar (o falló con otra regla), con su `rule` obtenido.
- `node packages/core/src/harness.ts` imprime el reporte JSON y sale con código 1 si algo falla.
- Prueba: `runAll()` sale todo `ok`; y una mutación del registro (quitar `revoked_at`) hace que `retry_after_revocation` reporte contraejemplo con `contract_version`.
- TDD obligatorio.
