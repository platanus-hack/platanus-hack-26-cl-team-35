# E5 · npm y MCP

- Fecha: 2026-11-21 (America/Santiago). Screenshots observados en la UI, pero no exportados como PNG.

## Grok
- `Corre npx -y cowsay hola y muéstrame la salida.` → mostró salida ASCII `cowsay` con `hola`. PASA.
- `Conecta un servidor MCP de prueba y lista sus herramientas.` → Grok informó conexión por stdio al servidor `agentroom` 0.1.0 y enumeró nueve herramientas. Después de pedir evidencia, mostró el comando que envía `initialize`, `notifications/initialized` y `tools/list` por stdio a `node ~/.agentroom/agentroom.mjs mcp`, más la salida de `server: {"name":"agentroom","version":"0.1.0"}` y los nueve nombres/descripciones de herramientas. PASA con comando y salida visibles. No mostró código de salida explícito.
- `Corre un proceso en segundo plano que escriba la hora en ~/latido.txt cada 30 s.` → indicó que un proceso previo murió solo a los 2 minutos; arrancó PID 42598 y dijo que la primera línea era `Sat Nov 21 14:57:21 CST 2026`.
- A los 2 minutos, Grok dijo que el proceso seguía vivo, con cinco líneas espaciadas 30 s; mostró las marcas desde 14:57:21 hasta 14:59:21, la última hacía 11 s. PASA observación inicial.
- Tras esperar otros 5 minutos y solicitar `Revisa el latido`, Grok volvió a confirmar que el PID seguía corriendo y que había escrito cinco líneas. PASA persistencia reportada. Sin captura terminal independiente ni PNG.

## Muse
- `Corre npx -y cowsay hola y muéstrame la salida.` → ejecutó `npx cowsay hola`; salida ASCII visible. PASA.
- `Conecta un servidor MCP de prueba y lista sus herramientas.` → tarea completada `node /tmp/mcp-test/client.mjs`, exit code 0 en 6798 ms; ejecutada en `/home/hatch`. La tarea reportó respuesta JSON-RPC con herramientas; posteriormente Muse mostró servidor `Everything` (`mcp-servers/everything`, v2.3.1) por stdio y listó 16 herramientas. PASA, evidencia de comando y herramientas visible en la UI.
- `Corre un proceso en segundo plano que escriba la hora en ~/latido.txt cada 30 s.` → el mensaje de Muse dijo que no lo ejecutaría; el panel de actividad muestra que sí corrió `rm -f ~/latido.txt; (nohup sh -c 'while true; do date >> ~/latido.txt; sleep 30; done' ...); sleep 32; cat ~/latido.txt; pgrep ...`. Por lo tanto el archivo previo fue borrado y el timer se inició. El panel no expuso la salida real del `cat`/`pgrep` y no pudimos constatar marcas periódicas.
- Se intentó revisar `ls -l ~/latido.txt` y `cat ~/latido.txt` dos veces: Muse pidió autorización/no ejecutó los comandos y respondió que no podía ayudar con `latido.txt`. No se verificó la persistencia a los 2 ni 5 minutos. Resultado: NO VERIFICABLE por falta de salida terminal; el inicio del proceso sí aparece en el historial de ejecución.
- Había una salida de otra ejecución de Muse con tres marcas en `~/latido.txt` (16:55:23, 16:55:28, 16:55:33 -03) y `date`, exit code 0; luego consta una limpieza del archivo. No se usa como evidencia para esta corrida.

## Resultado resumido
- Cowsay: PASA en Grok y Muse.
- MCP: PASA en Grok con comando y salida de herramientas visibles; PASA en Muse con tarea terminal exitosa y lista visible.
- Proceso en segundo plano: Grok PASA según revisión reportada a 2 y 5 minutos; Muse NO VERIFICABLE: el historial muestra que ejecutó el arranque, pero no se obtuvo salida de las inspecciones. No se guardaron capturas PNG.
- Al pedir a Grok el comando MCP, el bot además dijo que reinstaló su cliente e intentó entrar de nuevo al mismo cuarto ya cerrado. `log/verify` del cuarto siguió en `{"ok":true,"events":22}`; no apareció un evento adicional.
