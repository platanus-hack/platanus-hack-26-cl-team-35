# @agent-board/core

Motor de compromisos entre agentes de organizaciones distintas. Un evento tipado y validado es lo único que cambia el estado; el texto libre (`note`) es solo contexto.

Contrato (`src/contract.ts`), escenario de referencia LogisticsTech (`src/scenario.ts`), policy gate, motor, outbox y harness de verificación (`src/harness.ts`).

## Estados

`requested -> offered -> accepted -> executing -> delivered -> verified`, más `rejected` y `cancelled` como finales. `delivered` pasa a `verified` solo con un recibo del destinatario para el `deliver`. Una `counteroffer` deja el compromiso en `offered` y reemplaza la oferta vigente.

## Kinds

`request`, `offer`, `counteroffer`, `accept`, `start`, `deliver`, `receipt`, `verify`, `reject`, `cancel`, `read_evidence`. Todos requieren `source_event_id` salvo `request`. `accept` cita una decisión humana (`decision_id`, `approver_id`) y su alcance; `deliver` lleva evidencia por referencia `{ ref, sha256 }`.

## Reglas del gate

`contract_version`, `expired`, `sender_registered`, `sender_valid`, `recipient_registered`, `capability`, `party`, `transition`, `source_event`, `approval`, `double_booking`, `receipt_required`, `evidence_scope`. Cada una con `rule_version` `"1"`. Un `event_id` repetido es un duplicado idempotente, no un rechazo.

## Decisiones humanas y revocación

La aprobación no la afirma el agente. Una persona registra `engine.decide(decision, now)` con `{ decision_id, person_id, case_id, task_id, resource_id, offer_event_id, approve, conditions?, decided_at }`; el motor la rechaza con `approval` si la persona no existe, no tiene `may_approve`, no es de la org del requester, la oferta no es la vigente o el `decision_id` ya existe (`transition` si la tarea no está en `offered`). El `accept` solo pasa si cita una decisión que existe, es del `approver_id`, aprueba y tiene el mismo alcance. `engine.decisions()` devuelve copias del log de decisiones.

`engine.revoke(agent_id, at)` fija `revoked_at` del agente (agente desconocido: `sender_registered`; se conserva la fecha más temprana). `source_event` exige además que el evento origen sea de la misma tarea.

## Cliente HTTP

`coreClient({ baseUrl, caseId, token, fetch? })` (`src/client.ts`) envuelve las rutas del servidor: `send(event)`, `readEvidence(event)`, `inbox()`, `state()`. Devuelve el JSON; ante un no 2xx lanza un `Error` con `status` y `body` (`error`, `hint`, `rule_version`). Sin reintentos ni dependencias.

## Alcance

El motor, el servidor (`packages/server`, rutas `/core`), la vista con decisiones, los avisos y este cliente están construidos. El paso 6 del plan todavía no existe.

## Pruebas

`node --test packages/core/test/` (Node 24).

## Harness

`node packages/core/src/harness.ts` imprime un reporte JSON y sale con 1 si algo falla. Repite el escenario de referencia y los casos `ADVERSARIAL` (double booking, duplicado, expirado, agente revocado y reintento tras revocar, aprobación prestada o citada, lectura fuera de alcance, entrega fallida, instrucciones en evidencia o notas). `replay` recibe entradas (`Input`): eventos, `{ type: "decision", decision }` o `{ type: "revoke", agent_id, at }`; `withDecisions(events, decisions)` intercala cada decisión antes de su `accept`, y la traza cubre solo eventos. Incluye `fabricated_decision` y `rejected_decision`. Cada caso lleva su registro y sus entradas; un fallo trae un contraejemplo con el evento, lo esperado, lo observado y `contract_version`. Tras cada caso revisa invariantes: ningún recurso con dos compromisos activos, todo evento del log re-autorizado por el gate, lecturas solo de orgs del caso y ningún `verified` sin recibo del `deliver`.

El invariante (b) (todo evento del log re-autorizado) es un chequeo de determinismo y de deriva del registro: reproduce el log con el mismo gate, así que no es una verificación de autoridad independiente.
