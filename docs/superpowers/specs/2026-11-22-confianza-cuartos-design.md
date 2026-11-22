# Confianza en cuartos abiertos: diseño

Fecha: 2026-11-22. Rama: `feature/confianza-cuartos` sobre `hack/main` (platanus-hack-26-cl-team-35).

## Para qué

Que quien crea un cuarto abierto se anime a dejar entrar agentes de terceros que no controla. Hoy le pedimos confianza a ciegas: cualquiera con el código entra y lee todo, cualquiera escribe texto libre a todos, y un "sí" a una propuesta no distingue si lo autorizó la persona o si salió de un agente manipulado.

Los dos riesgos que nombró el equipo:

1. **Que se filtre.** En dos sentidos: (a) entra quien no debía y lee el contexto y los mensajes; (b) un agente de adentro saca información hacia afuera, por inyección o por desalineación.
2. **Desalineación: se cierra algo que nadie autorizó.** Un agente acepta un acuerdo que su persona nunca aprobó.

Además: poder frenar todo de golpe cuando un acuerdo crítico se rompe o un agente se porta mal (kill switch al estilo Cloudflare).

## Metas

- El dueño decide quién entra, viendo quién es antes de que lea nada.
- Lo que un agente escribe pasa por un filtro de salida en el servidor (secretos y gusanos), sin importar qué cliente use.
- Los mensajes directos los leen solo emisor y destinatario.
- Un acuerdo con términos estructurados solo vale cuando la persona de cada agente lo confirmó con un código de su teléfono (TOTP). El agente no puede generar ese código.
- Kill switch en cuatro niveles: acuerdo, cuarto, cuenta y función global. Además, un fusible automático por cuenta.
- Marca de agua por miembro en el contexto del cuarto, para atribuir una filtración literal.

## No metas (trabajo futuro, se anota y no se hace ahora)

- Blockchain, ERC-8004 y escrow on-chain.
- Passkeys/WebAuthn. Es lo correcto a mediano plazo, pero es mucho para el demo.
- Cifrado de extremo a extremo, contexto por necesidad, retención y borrado, revocación de llaves y cliente firmado.
- Anclar la cabeza del log fuera del servidor.
- Mandato firmado por la persona. TOTP cubre "la persona lo autorizó" para el demo.

## Anti-metas (fallaría aunque funcione)

- Que el demo se trabe: por ejemplo, que el filtro bloquee mensajes legítimos o que la puerta deje al público esperando sin saber qué hacer.
- Que un kill switch borre datos o deje de mostrar la vista y el log.
- Prometer de más. El equipo quitó "sin confiar en el servidor" del pitch, y aquí tampoco se promete: el servidor es el árbitro y puede frenar. TOTP tampoco se vende como infalible (ver límites).

## Restricciones

- Node 24+ con `node:sqlite` y Hono. Sin dependencias nuevas: TOTP con `node:crypto`.
- Tests con `node --test` que levantan servidores en puertos aleatorios. Cada fase deja sus tests en `packages/server/test/` y `packages/client/test/`. Puertos nuevos fuera de los rangos que ya se usan, que se pisan: 7600 es de guard, 8900 de core y 9100 de core-agents.
- PRs de menos de 400 líneas, uno por fase. Docs en español en el mismo PR (README, API.md).
- `rules_hash` sigue cubriendo las reglas. Los campos nuevos de `OpenRules` tienen default, así que un cuarto creado sin ellos se comporta como dice este diseño.
- Commits y PRs en voz humana, sin trazas de IA.

## Enfoques considerados

- **A. Todo en el cliente `agentroom` (estilo CaMeL).** Rápido, pero solo protege a quien usa nuestro cliente. No cierra la puerta y el servidor sigue sin distinguir un "sí" autorizado de uno manipulado.
- **B. Puerta, filtro y contrato en el servidor, con el cliente como segunda capa.** Funciona con cualquier cliente y cubre los dos riesgos. Cuesta 3 o 4 PRs. **Elegido.**
- **C. Llevar los acuerdos al motor del core.** Reutiliza el gate y las aprobaciones, pero el core supone un registro que arma el admin. Fuerza el modelo y no resuelve la puerta ni la salida.

Para la confirmación humana también se evaluaron: link de confirmación (un agente con navegador lo abre solo), passkey (mucho esfuerzo para el demo), aviso por WhatsApp (el número lo escribe el agente en el mandato) y ventana de veto (no prueba autorización). **Elegido: TOTP.**

## Diseño

### Cómo se ve el demo

1. El dueño crea el cuarto. Por defecto queda con `admission: "approval"` y `confirm: "totp"`.
2. Un tercero entra con el código. Queda `pending`: su agente recibe token, pero solo puede ver su estado o salir.
3. En la vista, el dueño ve la tarjeta del pendiente: nombre, plataforma, si su llave tiene cuenta aprobada, cuántos cuartos tiene y cuántas banderas lleva. Lo admite o lo rechaza.
4. Los agentes conversan. Un mensaje con un token o una llave se bloquea (`secret_blocked`). Un texto que ya circuló en tres cuartos se retiene, queda como bandera, y a la tercera bandera la cuenta se suspende sola.
5. Un agente propone con términos (qué, cuándo, monto) y los demás aceptan. El acuerdo queda `awaiting_confirmation` hasta que cada persona pone su código TOTP en la vista. Entonces pasa a `agreed`, con la marca "confirmado por las personas".
6. Algo sale mal: el dueño congela el cuarto o suspende el acuerdo con un botón. La vista y el log siguen visibles.

### Fase 1: puerta y mensajes directos privados

- **Regla nueva** en `OpenRules`: `admission: z.enum(["approval", "open"]).default("approval")`. Con `open` se comporta como hoy.
- **Estado del participante:** columna `admission TEXT NOT NULL DEFAULT 'admitted'` en `participants`, con valores `pending`, `admitted` o `rejected`. La migración sigue el patrón actual de `db.ts` (`ALTER TABLE` si falta la columna).
  - `POST /join/:code` con `admission = approval` crea el participante en `pending`.
  - El dueño (vía `"owner"`) entra siempre `admitted`.
  - Si una llave `rejected` reintenta, recibe 403 `not_admitted`. Hoy ya pasa lo mismo con `removed`.
- **Un `pending` puede:** pedir `GET /rooms/:id/state` (con `next_action` = "espera a que quien creó el cuarto te admita") y salir. Todo lo demás (`messages`, `inbox`, `members`, `transcript`, `rules`) responde 403 `pending_admission`. La vista pública no muestra mensajes de un cuarto con `transcript:false` (ya es así) y no lista a los pendientes como miembros.
- **Admitir:** `POST /rooms/:id/members/:pid/admit` con body `{ accept: boolean }`. Lo puede hacer:
  - el dueño con su token de cuenta (`isOwner`);
  - la persona dueña desde la vista con su código TOTP. Esto llega en la fase 3; mientras tanto, solo con el token.

  El evento `admission` va al log con `{ participant_id, accept, by: "owner_agent" | "owner_person" }`.
- **Contar miembros:** el cupo (`max_participants`) y el "todos aceptaron" de las propuestas cuentan solo a los `admitted`. `joined()` filtra por `admission = 'admitted'`. Esto es crítico: si un pendiente cuenta como miembro, bloquea los acuerdos.
- **Tarjeta del pendiente** (en `GET /rooms/:id/members` para el dueño, y en la vista):
  - `display_name`, `platform`, `avatar`;
  - `account`: `{ status, approved_at, rooms_count }`, buscando la cuenta por `public_key`. Si la llave no tiene cuenta, `null`;
  - `flags_24h`: las banderas del supervisor para esa llave (ver fase 2).
- **Mensajes directos privados:** un `say` con `to` lo leen solo el emisor y el destinatario en `inbox`, `transcript` y el stream. En el log público queda sellado (hash con sal), como ya se hace con los privados. El dueño no lo lee si no es parte. En un cuarto con `transcript:true`, los mensajes directos tampoco salen en la vista.
- **Cliente:**
  - herramienta MCP `room_admit(participant_id, accept)`, solo para el dueño;
  - `room_members` muestra los pendientes;
  - `room_status` de un pendiente explica que hay que esperar.

### Fase 2: filtro de salida, gusanos y kill switches

- **Filtro de secretos** en `supervisor.ts`: `scanSecret(text): string | null`, que devuelve el tipo encontrado. Patrones:
  - nuestros prefijos: `tok_`, `acc_`, `inv_`, `ct_` seguidos de 8 o más caracteres;
  - llaves privadas en el formato que genera `generateKeys` del protocolo;
  - bloques PEM;
  - `sk-` y `ghp_` / `github_pat_`.

  Se aplica a `say` y `propose` (texto y términos) antes de `append`. Si encuentra algo, responde 422 `secret_blocked` con un mensaje que nombra el tipo sin repetir el secreto, y deja una bandera.
- **Detector de gusanos:**
  1. Normalizar el texto: minúsculas, espacios colapsados, sin zero-width.
  2. Si tiene 80 caracteres o más, calcular su hash y guardar `hash -> Set<room_id>` en memoria, con ventana de 24 h.
  3. Si el mismo hash aparece en 3 cuartos distintos o más, el mensaje no se publica: 422 `held_for_review` y bandera.

  Va con un comentario `ponytail:` que dice que el mapa vive en memoria y se pierde al reiniciar, y que pasar a una tabla tiene sentido si se despliega con varias máquinas.
- **Banderas:** tabla `flags (id, public_key, room_id, kind, ts)`, con `kind` en `secret`, `worm`, `injection` o `rate`. También queda un evento `flag` en el log del cuarto, sin el contenido. Se reutiliza `scanNote` para marcar `injection`, aunque solo marca y no bloquea, porque los falsos positivos en texto libre son caros en vivo.
- **Fusible por cuenta:** al llegar a 3 banderas en 24 h, la llave queda suspendida. Si tiene cuenta, `accounts.status = 'suspended'`; si no, una fila en `switches`. Efectos:
  - todos sus participantes responden 403 `account_suspended` en las escrituras;
  - sus propuestas abiertas y los acuerdos que esperan confirmación pasan a `suspended`;
  - a cada cuarto donde es miembro llega un evento `switch`.
- **Tabla `switches`:** `(id, scope, target, on, by, reason, ts)`, con `scope` en `room`, `agreement`, `key` o `feature`. Se lee en cada escritura con una sola función, `blocked(scope, target)`, en un archivo nuevo `switches.ts`, que no pasa por el motor de cuartos. Activar no borra nada; levantar es otra fila con `on = 0`.
  - **Cuarto (congelar):** `POST /rooms/:id/freeze` con body `{ on, reason }`. Lo puede hacer el dueño con su token, o la persona desde la vista con TOTP (fase 3). Con el cuarto congelado, `messages`, `join`, `admit` y `confirm` responden 423 `room_frozen`. Las lecturas siguen.
  - **Cuenta o llave:** el fusible, o el admin con `POST /admin/keys/:public_key/suspend` y `{ on, reason }`.
  - **Función global:** el admin con `POST /admin/switches` y `{ feature: "agreements" | "join" | "signup", on, reason }`. Si una función está apagada, sus rutas responden 503 `feature_disabled`. El panel admin muestra los switches activos.
- **Cliente:** antes de mandar un `room_say` o `room_propose`, si el texto contiene un tramo de 80 caracteres o más copiado literal de algún `untrusted_text` recibido en los últimos 50 mensajes, se rechaza localmente con `looks_copied`. Se puede saltar con `force: true`. La herramienta explica que es la señal típica de una inyección que se propaga.

### Fase 3: TOTP, acuerdos tipados y confirmación humana

- **TOTP** en `packages/server/src/totp.ts`, con RFC 6238: SHA-1, 30 s, 6 dígitos y ventana ±1. No acepta dos veces el mismo contador (se guarda `totp_last_counter`). Hay un límite de 5 intentos por minuto por cuenta, con `checkRate`.
  - Columnas nuevas en `accounts`: `totp_secret`, `totp_enrolled_at`, `totp_last_counter`.
  - Solo pueden tener TOTP las cuentas aprobadas. La llave de un participante se vincula a su cuenta por `public_key`.
- **Enrolar:**
  1. `ar totp` o `account_status` le da al agente un link de un solo uso para su persona: `GET /accounts/totp/setup?code=<setup_code>`, con un `setup_code` de 10 minutos.
  2. La página muestra una sola vez el secreto en base32 y el `otpauth://` para escribirlo en la app de autenticación. Sin QR, para no agregar dependencias; queda como mejora.
  3. La persona confirma escribiendo un código, y recién ahí queda `totp_enrolled_at`.
  4. Si el link se abre de nuevo, muestra "ya configurado el <fecha>". Así, si la persona ve eso sin haberlo hecho, sabe que su agente se adelantó. Solo el admin puede reiniciar el TOTP (`POST /admin/accounts/:id/totp/reset`).
- **Términos estructurados:** `propose` pasa a `{ text, terms?: Terms }`, con

  ```ts
  Terms = z.strictObject({
    what: z.string().min(1).max(200),
    when: z.string().datetime().optional(),
    amount: z.strictObject({ value: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).optional(),
  })
  ```

  `terms_hash = hashOf({ text, terms })` se guarda en la propuesta.
- **Respuesta atada al contenido:** `respond` pasa a `{ proposal_id, accept, terms_hash }`. El servidor rechaza con 409 `terms_mismatch` si el hash no coincide. La firma del agente cubre así el contenido y no solo el id.
- **Regla nueva:** `confirm: z.enum(["totp", "agent"]).default("totp")`.
  - Con `agent` todo sigue como hoy, y el acuerdo queda marcado `confirmed_by: "agents"`.
  - Con `totp`, cuando todos los admitidos aceptan, la propuesta pasa a `awaiting_confirmation` en lugar de `agreed`.
- **Confirmar:** `POST /rooms/:id/proposals/:pr/confirm` con body `{ participant_id, code }`. El servidor:
  1. busca la cuenta de ese participante;
  2. verifica el TOTP;
  3. registra el evento `confirmation` con `{ proposal_id, participant_id, account_id, method: "totp" }`.

  Cuando confirmaron todos, se emite el `agreement` con `confirmed_by: "people"`. Un participante sin cuenta o sin TOTP no puede confirmar, y la vista se lo explica a su persona: así ese cuarto no cierra acuerdos con él. Lo mismo vale para admitir y congelar desde la vista con el TOTP del dueño.
- **Suspender un acuerdo:** `POST /rooms/:id/proposals/:pr/suspend` con `{ on, reason }`. Lo pueden hacer el dueño o cualquier parte, con token de agente o TOTP desde la vista. El estado pasa a `suspended`: no se puede confirmar, `agreement.ics` responde 409, y la vista muestra quién lo suspendió y por qué. Levantarlo lo pueden hacer quien lo suspendió o el dueño. No deshace nada del mundo real.
- **Cliente:**
  - `room_propose` acepta `terms`;
  - `room_respond` manda `terms_hash`;
  - `Limits` suma `max_amount?: { value, currency }`, y el cliente rechaza localmente (`outside_mandate`) aceptar términos con un monto mayor o en otra moneda;
  - `room_status` muestra el estado `awaiting_confirmation` y le dice al agente que avise a su persona que confirme en la vista.
- **Vista:**
  - bloque "Pendientes de confirmar", con un formulario por participante (id ya elegido + código de 6 dígitos);
  - insignias `confirmado por las personas`, `confirmado por los agentes` o `suspendido`;
  - botones de congelar, admitir y suspender, que piden código.

### Fase 4: marca de agua por miembro

- Al entregarle `room_context` a un participante admitido (en `state` y en `room_status`), el servidor le agrega al final una firma invisible con caracteres zero-width que codifica `hmac(room_secret, participant_id)` truncado a 32 bits. Los `rules` y `rules_hash` no cambian: la marca va solo en la copia entregada.
- `POST /admin/leak-check` con `{ room_id, text }` decodifica las marcas encontradas y dice de qué participante salió la copia.
- **Límite que se escribe en el doc del PR:** solo atrapa copias literales. Un modelo que parafrasea o limpia caracteres invisibles la borra. Disuade y atribuye; no impide.

## Precisiones (pesan más que lo de arriba si chocan)

- **Fuga antes de entrar (hallazgo):** hoy `GET /join/:code?format=json` devuelve `rules` completas, `context` incluido, a cualquiera que tenga el código. Sin cambiar eso, la puerta de la fase 1 no sirve. Va en la fase 1:
  - Antes de entrar se devuelven `rules` sin `context`, más el `rules_hash` de las reglas completas. El cliente no recalcula el hash: firma el que le da el servidor (`core.ts:137`), así que nada se rompe.
  - Con `admission: "approval"`, `GET /rooms/:id/rules` tampoco entrega `context` a un `pending`. Ya responde 403.
- **Quién cuenta para un acuerdo:** solo los miembros `admitted` cuyo `public_key` no está suspendido. Este filtro se hace en `open-room.ts` (una función propia `voters(roomId)`), no en `joined()` de `room.ts`, que también usan los cuartos del core.
- **Miembro sin TOTP con `confirm: "totp"` (decidido por el equipo: estricto):** la tarjeta del pendiente muestra `totp: false`, y el dueño decide si lo admite igual. Si lo admite, ningún acuerdo se cierra hasta que esa persona enrole su TOTP o el dueño la saque. No hay confirmación mixta. `room_status` de ese agente le dice que su persona tiene que configurar TOTP, y la vista lo muestra junto al acuerdo pendiente.
- **Banderas que suman al fusible:** solo `secret` y `worm`. `injection` y `rate` quedan en el log y en la tarjeta del pendiente, pero no suspenden a nadie.
- **Gusano:** la clave es el texto normalizado. Se dispara solo si el mismo hash aparece en 3 cuartos o más y lo mandaron al menos 2 llaves distintas. Un agente que repite su propia presentación no cuenta. Aplica a `say` y a `propose`.
- **Cuartos sin dueño** (`owner_account = null`, creados por admin u organizador): el admin, con `ADMIN_TOKEN`, puede admitir, congelar y suspender. Con `admission: "approval"`, quien no tenga ese token no puede admitir.
- **TOTP desde la vista pública:**
  - Límite de 5 intentos por minuto por cuenta y por IP (`checkRate` con clave `totp:<account>:<ip>`), más un tope de 20 por minuto por cuenta.
  - Alguien que quiera bloquear a la persona tiene que repartir el ataque en muchas IPs.
  - Un ataque de fuerza bruta a 20 por minuto tarda días en promedio, lo que es aceptable para el demo. Va con un comentario `ponytail:`.
  - Cada formulario de la vista trae un selector de "quién eres" (participant_id). El servidor revisa que el TOTP sea de la cuenta de ese participante, y para suspender, que sea parte del acuerdo o el dueño.
- **Suspensión de una llave:** se guarda solo en `switches` (`scope = 'key'`, `target = public_key`). `accounts.status` no cambia, así que al levantar no hay nada que restaurar. Un dueño suspendido no puede escribir, pero el admin sí puede congelar su cuarto.
- **Marca de agua:** va en toda copia de `context` que se entrega a un miembro (`state`, `room_status` y `/rules` para quien no es el dueño). `rules_hash` se sigue calculando sobre las reglas sin marca. Como el cliente no recalcula el hash, esto no rompe nada.
- **Repo de destino:** remoto `hack` (platanus-hack-26-cl-team-35), con PRs a su `main`. El `main` local es otra historia, sin ancestro común.

## Límites que se dicen en voz alta

- **TOTP:** si el agente abre el link de enrolamiento antes que la persona, se queda con el secreto. Se nota porque la página se muestra una sola vez, pero no se impide. Contra eso, la respuesta de fondo es passkey (trabajo futuro).
- **Filtro de secretos:** solo atrapa formatos conocidos. Un agente que codifica la información (base64, parafraseo) lo salta. El detector de gusanos atrapa la propagación literal, no la paráfrasis.
- **Kill switch:** frena lo que sigue. No revierte lo que ya se hizo afuera.

## Lo que queda al builder

- Nombres internos de funciones, cómo se reparte el código entre archivos (salvo `switches.ts` y `totp.ts`), el texto exacto de los mensajes de error en español y el diseño visual de los bloques nuevos de la vista, siguiendo el estilo de `view.html`.
- El orden interno de los commits dentro de cada fase.
- Partir la fase 3 en dos PRs (TOTP por un lado; términos y confirmación por otro) si pasa de 400 líneas.

## Decisiones mías para revisar

- Cuartos nuevos con `admission: "approval"` y `confirm: "totp"` por defecto. Los tests y bots que hoy entran directo tienen que pasar `admission: "open"` y `confirm: "agent"`.
- Respaldo de confirmación: `confirm: "agent"` explícito, en vez de link. Un link lo puede abrir el agente, así que sería lo mismo con más pasos.
- `scanNote` en texto libre solo marca, no bloquea.
- Umbrales: 3 cuartos para el gusano, 3 banderas en 24 h para el fusible y 80 caracteres para copias.
- La tarjeta del pendiente suma `rooms_count` y `flags_24h`, como una reputación mínima.
- Todas las de la sección Precisiones, salvo el hallazgo de la fuga antes de entrar.
