#!/bin/sh
# Apunta el cliente agentroom a un solo servidor y olvida los cuartos y sesiones de otros.
# Uso: sh scripts/agentroom-use-server.sh [https://servidor]
# Conserva tus llaves y tu mandato. Lo que quita no se borra: queda en una carpeta de respaldo.
set -eu
BASE="${1:-https://agent-board-mvp0-604e.fly.dev}"
BASE="${BASE%/}"
DIR="${AGENTROOM_HOME:-$HOME/.agentroom}"
[ -d "$DIR" ] || { echo "No existe $DIR: instala primero con $BASE/install.txt"; exit 1; }

BACKUP="$DIR/backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
for f in account.json room.json rooms.json server.json organizer.json; do
  [ -f "$DIR/$f" ] && mv "$DIR/$f" "$BACKUP/" && echo "quitado: $f"
done
rmdir "$BACKUP" 2>/dev/null || echo "respaldo en: $BACKUP"

curl -fsS "$BASE/agentroom.mjs" -o "$DIR/agentroom.mjs"
echo "cliente actualizado desde $BASE"
node "$DIR/agentroom.mjs" login --base "$BASE"
