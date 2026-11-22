# Especificación del hospital agéntico

[Roadmap y criterios de aceptación](roadmap-hospital-agentico.md)

## Arquitectura

Un hub por sitio corre Hono y SQLite en una laptop o Jetson. Aloja el panel, el historial de eventos y los agentes locales de coordinación, transporte y recepción. El hub conserva la autoridad de escritura. La app móvil guarda pendientes y una copia fechada de los datos que su rol puede consultar. Un gateway separado controla las conexiones de asistentes personales. La demo usa exclusivamente encuentros y documentos sintéticos.

| Componente | Encaje en el repositorio |
| --- | --- |
| Compromisos | Reutilizar el gate, las decisiones humanas y el recibo de [`packages/core`](../packages/core/README.md). El flujo pasa por `request → offer → accept → start → deliver → receipt → verify`. |
| Hub | Añadir rutas del dominio hospitalario junto a [`/core`](../packages/server/src/core/routes.ts). El dominio compone el core con disponibilidad, eventos de dispositivos y autenticación del personal. |
| Estado | Reutilizar SQLite y [replay por caso](../packages/server/src/core/store.ts). Guardar inventario compartido, evidencias y estado sincronizado como datos del sitio. |
| Integraciones | Usar [`coreClient`](../packages/core/src/client.ts) para agentes. El [MCP actual](../packages/client/src/mcp.ts) expone herramientas de cuartos y requiere herramientas hospitalarias propias. |
| Dispositivos | App nativa de iPhone para NFC, cámara, OCR y transporte de proximidad. Firmware opcional en ESP32, con un puente USB al hub cuando haya dos placas. Los dispositivos registran observaciones con identidad propia. |

## Modelo y transiciones

- **Traslado**. `transfer_id`, referencia opaca al encuentro, origen, servicio requerido, prioridad ingresada por personal, estado y versión. `task_id` identifica el compromiso y `resource_id` el turno de destino. El plan guarda la versión del grafo y los datos de capacidad usados.
- **Oferta**. Turno, ruta, hora estimada, caducidad, restricciones y versión. La decisión humana se vincula con la oferta exacta. Si cambia el destino o el recurso, liberar el compromiso anterior de forma controlada y abrir otro. Durante ejecución, pausar en un punto seguro y solicitar indicaciones al operador. Un cambio de ruta con el mismo turno usa una revisión del plan con aprobación registrada.
- **Reserva**. Una fila activa por `(facility_id, resource_id, slot_id)`. Persistir evento aceptado y reserva en la misma transacción. Publicar estado y ACK tras commit. Ante error, descartar el estado en memoria de esa operación y reconstruir desde SQLite antes de reintentar. El gate actual tiene un mapa por motor y el servidor un motor por caso. La reserva del sitio cubre la competencia entre casos.
- **Llegada**. Personal receptor registra el recibo contra la entrega. El hub puede enlazar el código escaneado y una observación reciente del checkpoint como evidencia adicional. Guardar emisor, origen y hora. Cancelación, cambio de destino y liberación requieren identidad y motivo auditados. Conservar las transiciones del core para cerrar el traslado.
- **Orden de prioridad**. La establece personal autorizado. El planificador optimiza logística dentro de las restricciones registradas. Cuando capacidad o estado tienen datos incompletos, la propuesta se marca para revisión y el operador puede confirmar por el canal habitual.

## Interfaces propuestas

| Interfaz | Contrato mínimo |
| --- | --- |
| `POST /hospital/handoffs` | `request_id`, encuentro opaco, origen, servicio. El hub carga prioridad del registro autorizado y devuelve `transfer_id` y versión. El mismo identificador y contenido devuelven el resultado previo. Cambiar contenido bajo el mismo identificador da conflicto. |
| `GET /hospital/handoffs/:id` | Estado, versión, hora de actualización, oferta vigente y datos mínimos según rol. Todas las lecturas validan alcance antes de buscar datos. |
| `POST /hospital/handoffs/:id/decisions` | Personal autenticado, `offer_id`, versión, decisión y motivo si aplica. Una versión obsoleta produce conflicto y pide refrescar. |
| `POST /hospital/sync/events` | Sobre enrolado y firmado con `event_id`, `device_id`, versión de esquema, secuencia, tipo, fecha, vencimiento y carga tipada. Respuesta por evento con estado, versión y ACK del hub desde almacenamiento durable. |
| `POST /hospital/observations` | Ingesta interna con permisos por dispositivo y zona. Datos físicos, fuente, calidad y frescura separados de la confirmación humana. |

### Transporte local

La LAN sirve el camino principal. La app guarda primero en su outbox durable y utiliza un relay enrolado mediante Bluetooth LE GATT o Nearby Connections, según lo que se valide en M0. El relay almacena el sobre cifrado para el hub, conserva su identidad original y devuelve el ACK del hub al emisor. Limitar TTL, tamaño y cola. Validar identidad, firma y permisos al recibir, deduplicar por ID y detectar contenido incompatible. Una actualización caducada queda visible y requiere revisión. Cuando el hub es inaccesible, solo se muestran estados locales fechados y envíos pendientes. Las reservas y aprobaciones se vuelven efectivas en el hub. [Nearby Connections](https://developers.google.com/nearby/connections/overview)

ESP-NOW cubre el tramo opcional entre placas y se prueba como transporte separado. Registrar distancia, pérdidas y reintentos reales. Usar USB entre la placa receptora y el hub para la demo y confirmar coexistencia de radios si se decide compartir el medio. [Guía ESP-NOW de Espressif](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_now.html)

## Sensores y captura

El inventario previo del equipo reporta Ray-Ban Meta, Jetson Orin Nano de 8 GB y dos ESP32D. M0 confirma disponibilidad, modelo y funcionamiento para esta demo. Los periféricos de la tabla dependen del inventario real.

| Entrada | Uso y validación |
| --- | --- |
| NFC del iPhone | Leer en primer plano una etiqueta pasiva NDEF con un ID opaco de estación. Resolver el ID contra el catálogo local y rechazar etiquetas desconocidas. Registrar el toque como observación. La estación lleva un QR equivalente como respaldo. [Core NFC](https://developer.apple.com/documentation/corenfc/building-an-nfc-tag-reader-app) |
| ESP32 con pulsador o contacto magnético | Registra presencia de un operador o cambio de puerta en un punto fijo. Comprobar rebote, reinicio y desconexión. Si se usa un pulsador, el panel lo etiqueta como aviso manual del checkpoint. |
| ToF de corto alcance, si está disponible | Registra paso en el checkpoint. Calibrar distancia y montaje con puerta abierta, parada y tránsito en ambos sentidos. Un paso se correlaciona con un escaneo en la misma zona y ventana, y puede corresponder a otra persona. |
| Cámara de teléfono o Meta | Leer código QR de un solo uso cuando exista y usar OCR para etiquetas de texto. Mostrar previsualización y pedir validación de campos extraídos. Probar iluminación, enfoque y capturas parciales. Borrar la imagen tras el procesamiento. |
| Acelerómetro y giroscopio del iPhone | Durante un traslado simulado y con el teléfono fijado al carro, estimar duración en movimiento y pausas. Guardar agregados por tramo y cotejarlos con marcas manuales antes de incorporarlos al estimador. [Core Motion](https://developer.apple.com/documentation/coremotion/getting-processed-device-motion-data) |
| LiDAR del iPhone, si ARKit confirma soporte | Levantar geometría aproximada de un pasillo vacío durante la preparación. Verificar anchos con medición física antes de actualizar restricciones del grafo. [ARKit](https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/supportsscenereconstruction(_:)) |
| CO₂, si existe un sensor calibrable | Mostrar contexto ambiental y frescura de la medición. La señal queda fuera del detector de brotes y no se utiliza para inferir estado infeccioso. |

Cada observación registra `observation_id`, `device_id`, `zone_id`, `source`, `kind`, `observed_at`, `received_at`, `value`, `unit`, `quality` y `simulated`. Captura puntual, sin video continuo. El recibo requiere acción humana. Usar cámara del teléfono si DAT o el emparejamiento dependen de internet en el equipo disponible. Pantalla y audio de los lentes quedan condicionados al modelo, permisos y prueba de banco. [Meta DAT](https://developers.meta.com/wearables/device-access-toolkit/) · [OCR Android con modelo incluido](https://developers.google.com/ml-kit/vision/text-recognition/v2/android) · [Apple Vision](https://developer.apple.com/documentation/vision/recognizing-text-in-images)

La etiqueta de estación es reutilizable y se puede copiar. Su lectura aporta contexto al receptor autenticado. El QR de estación comparte el mismo ID fijo, mientras que el código del comprobante identifica el traslado. Validar que la estación coincide con el destino aprobado y que el receptor pertenece al equipo autorizado. Al perder el enlace, la app guarda la confirmación como pendiente y el hub comprueba la versión vigente al recibirla.

## Gemelo operativo, modelos y vigilancia

El grafo modela puertas, pasillos y servicios como nodos y aristas con disponibilidad, accesibilidad y hora de observación. El planificador elimina opciones incompatibles y ordena las restantes por espera estimada, tiempo de traslado y carga de recursos. Un simulador local de eventos discretos compara el plan base con alternativas ante cierres, turnos llenos y fallas de red. Guarda snapshot, semilla, versión y motivos para repetir la comparación. El modelo local puede redactar la explicación a partir de la salida tipada. El planificador y el gate deciden qué propuestas son válidas. El flujo opera también con explicación por plantilla.

El aprendizaje empieza por el estimador de tiempos, separado del gate. Generar una versión candidata a partir de trazas sintéticas de duración y disponibilidad. Evaluar con replay sobre episodios reservados y semillas fijas. Medir error absoluto de tiempo estimado, p95 de espera, visitas bloqueadas, reservas dobles, confirmaciones sin recibo y propuestas con datos vencidos. Promover solo si mejora el error o la espera sin empeorar ninguna restricción de seguridad. Mantener versión firmada, aprobación humana y rollback al baseline. Durante operación, el candidato corre en sombra hasta aprobarse.

Para vigilancia, el hub agrega recuentos confirmados por síndrome y ventana. Guardar además volumen de consultas, cobertura y estado de ingestión para diferenciar una subida de un retraso de datos. M6 usa un baseline estacional por día de semana y un intervalo predictivo con cobertura explícita. Marca datos insuficientes y agrupa ventanas con conteos escasos. El panel muestra alertas para revisión por personal, con la serie observada y el rango esperado. Evaluar un pronóstico de demanda de 24 horas por separado mediante validación cronológica contra persistencia y baseline estacional. Reportar precisión de alertas, falsas alertas por semana, adelanto y error de pronóstico. [CDC, vigilancia sindrómica](https://www.cdc.gov/nssp/php/about/)

## Gateway de asistentes

Herramientas iniciales `request_handoff` y `get_handoff_status`. Claude Code con Sonnet puede usar un proceso MCP local. Confirmar la integración real de Dot antes de comprometer el conector. El asistente solicita una gestión y recibe un estado logístico limitado a su propio alcance. El gateway asigna credenciales de corta duración, limita la tasa, aplica revocación y audita las llamadas. La conexión a la nube la inicia el conector y el hub mantiene las rutas internas en la LAN. Usar cargas estructuradas con campos permitidos y sin notas libres, imágenes ni datos clínicos. Los agentes locales siguen funcionando cuando el conector se queda sin internet. [Claude Code MCP](https://code.claude.com/docs/en/mcp)

## Verificación y piloto

- **Automatizada**. Extender el harness con carrera entre casos, fallo después de escritura antes de ACK, duplicados, reapertura tras reinicio, aprobación vencida, recibo faltante y replay determinista. Probar permisos del gateway, revocación y aislamiento por caso.
- **En banco**. Dos teléfonos, hub, checkpoint y corte de WAN. Medir reintentos, latencia hasta ACK, exactitud de OCR por tipo de etiqueta y ruido del sensor. Ensayar la caída del hub y la alternativa manual.
- **Para un piloto real**. Acordar con operaciones clínicas qué tareas se delegan, validar identidad y capacidad procedentes del sistema hospitalario, proteger almacenamiento y transporte, probar restauración y alta de equipos, fijar retención y revisión de accesos, y obtener aprobación institucional. Evaluar interoperabilidad del flujo con `Task`, `Encounter` y `Location` del EHR. [HL7 FHIR Task](https://www.hl7.org/fhir/R4/task.html)
