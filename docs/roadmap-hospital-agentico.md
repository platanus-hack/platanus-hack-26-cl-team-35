# Roadmap del hospital agéntico

El primer usuario es la persona que coordina traslados desde un área de atención a imagenología. El equipo receptor y transporte comparten el estado del traslado aunque se caiga internet. La propuesta usa un gemelo operativo local para comparar rutas y un punto de control físico para corroborar la llegada. El personal conserva la autoridad sobre prioridad, destino y confirmación.

[Especificación técnica](spec-hospital-agentico.md)

## Features

| Feature | Alcance de la demo |
| --- | --- |
| Coordinación local | Personal asigna prioridad y aprueba el destino. Agentes de imagenología y transporte proponen turno y ruta. El hub registra el recibo del equipo receptor. |
| Checkpoint con iPhone | Toque NFC para registrar la estación. QR como respaldo y OCR en el dispositivo para leer un comprobante sintético. El recibo se registra con una acción del receptor. |
| Gemelo operativo | Compara rutas para el mismo traslado. Un cierre de pasillo genera una nueva propuesta y el turno se conserva si el servicio receptor sigue disponible. |
| Comunicación de proximidad | Cola persistente y relay Bluetooth. La interfaz distingue un envío pendiente, un evento recibido por el hub y un traslado confirmado. |
| Sensores adicionales | Ray-Ban para captura bajo demanda, ESP32 para una segunda observación y Core Motion para estimar tiempos por tramo. LiDAR para levantar el mapa si el iPhone admite reconstrucción. Cada ampliación depende de la prueba de banco. |
| Ampliaciones | Evaluación del estimador en sombra, alerta local con recuentos sintéticos y gateway de asistentes personales con permisos por solicitud. |

## Hitos

Todos los hitos están propuestos. Los criterios se prueban con datos sintéticos y equipos de demo. M1 habilita el resto. M2, M3 y M4 pueden avanzar en paralelo una vez estable el contrato de eventos. M5 depende de la traza de M1 y M3. M7 puede diseñarse en paralelo y se habilita después de probar los permisos de M1.

| Hito | Entrega | Criterio de aceptación |
| --- | --- | --- |
| M0. Inventario y prueba de banco | Laptop o Jetson, iPhone, etiqueta NDEF y segundo dispositivo. Registrar modelo, firmware, sistema operativo y permisos. | Leer la etiqueta y ejecutar OCR con WAN cortada. Validar ambos teléfonos si se demuestra el relay. Para Ray-Ban, distinguir primer emparejamiento de reconexión. |
| M1. Traslado local | Servidor local, panel de coordinación, agentes de destino y transporte. Usuario sintético de recepción a imagenología. | Completar traslado en dos dispositivos sin WAN con aprobación humana y recibo. Reiniciar el servidor y recuperar el estado. Rechazar una aprobación fabricada y probar que dos casos concurrentes solo reservan un turno. |
| M2. Comunicación de proximidad | Aplicación móvil con outbox durable y reenvío por Bluetooth. | Con Wi-Fi del emisor apagado, reenviar a un par enrolado y verificar el ACK del hub. Repetir la entrega, reiniciar el teléfono y comprobar que el traslado existe una sola vez. |
| M3. Evidencia física y OCR | Etiqueta NFC pasiva en imagenología y captura bajo demanda desde el iPhone. Ray-Ban y checkpoint ESP32 son extensiones. | Leer NFC y OCR sin WAN, rechazar etiquetas desconocidas, comprobar el respaldo QR y completar con recibo manual si falla la lectura. Una captura errónea o señal duplicada jamás completa un traslado. |
| M4. Gemelo operativo | Grafo versionado de rutas, capacidad y equipos. Simulación local de alternativas ante un cierre o congestión. | Cerrar un pasillo en la demo, mostrar dos opciones cuando existan, explicar sus restricciones y elevar una nueva propuesta. Medir tiempos y verificar cero reservas dobles bajo replay. |
| M5. Aprendizaje en sombra | Proponer cambios al estimador de tiempos con trazas locales. Si Core Motion funciona en banco, sumar duración de movimiento y pausas por tramo. | Comparar sensores con marcas manuales y evaluar el modelo en escenarios reservados de red, demanda y ruido. Promover solo con mejora verificable y aprobación del operador. |
| M6. Vigilancia local | Detección de series inusuales con datos agregados de casos sintéticos y simulación de demanda. | Reproducir un incremento y períodos normales con datos atrasados. Registrar tiempo hasta alerta y falsos positivos. Evaluar el pronóstico por separado y activarlo solo si mejora un baseline. |
| M7. Asistentes personales | Gateway con Claude Sonnet o Grok primero. Muse y Dot según interfaz confirmada. | Crear y consultar una solicitud desde un proveedor real, bloquear otro caso y reintentos no autorizados, revocar acceso y terminar un traslado con el proveedor caído. |

## Demo integrada

**Preparación.** Hub con panel abierto, un iPhone autenticado como receptor y otro dispositivo como coordinador. Cargar un encuentro ficticio, un turno disponible y dos rutas hacia imagenología. Pegar NFC y QR con el mismo ID opaco de estación. Imprimir un comprobante ficticio para OCR. Desactivar datos móviles y cortar la WAN del punto de acceso dejando la LAN operativa. Verificar desde el teléfono que el panel responde y una página externa falla.

| Tiempo objetivo | Acción | Qué debe verse |
| --- | --- | --- |
| 0:00–0:45 | El coordinador pide el traslado a imagenología y aprueba el turno sugerido. | El panel muestra la prioridad ingresada, la ruta y el turno reservado. |
| 0:45–1:30 | El operador simula el cierre del pasillo A y aprueba la ruta B. | El gemelo recalcula sin internet, registra la revisión y conserva el turno. |
| 1:30–2:15 | En imagenología, el receptor toca la etiqueta con el iPhone y valida el código leído por OCR. | La app muestra el ID de estación y el código del traslado. El panel identifica cada fuente. Si falla NFC, usar QR. |
| 2:15–3:00 | Si el relay pasó M2, apagar Wi-Fi en el iPhone antes de confirmar la recepción y mantener el segundo dispositivo en LAN. El receptor confirma desde el iPhone. | El evento figura como pendiente hasta que el hub lo guarda y devuelve el ACK. Reenviar el mismo evento y verificar que el panel conserva un solo recibo. Si el relay no está listo, reconectar Wi-Fi y mostrar recuperación de la cola por LAN. |
| 3:00–3:30 | Abrir el historial del traslado. | Se ven turno, cambio de ruta, lectura del checkpoint, confirmación humana y cierre. Los eventos reenviados conservan su identidad. |

**Extensiones después del flujo principal.** Mostrar captura con Ray-Ban, una segunda señal ESP32 o la duración por tramo si pasaron la prueba de banco. La alerta de brote puede mostrarse con una serie sintética rotulada. Restaurar internet antes de la demostración con un asistente externo.

**Evidencia.** Grabar el estado de red, modelo del iPhone y origen de cada señal. Reportar tiempo hasta propuesta, demora hasta el ACK, intentos de lectura correctos sobre el total y recibos únicos tras reenvío. Si se muestra vigilancia, reportar alertas falsas sobre los escenarios normales ejecutados.
