#!/bin/zsh
set +e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.ditaranto.crm.plist"
PORT="5173"

cd "$PROJECT_DIR"
echo "Reiniciando Ditaranto CRM..."
echo ""

echo "1/4 Cerrando procesos viejos del CRM..."
if [[ -f "$PLIST" ]]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
fi

PIDS=("${(@f)$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)}")
if (( ${#PIDS[@]} > 0 )); then
  for PID in "${PIDS[@]}"; do
    echo "Cerrando proceso viejo en puerto $PORT: $PID"
    kill "$PID" 2>/dev/null
  done
  sleep 1
fi

PIDS=("${(@f)$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)}")
if (( ${#PIDS[@]} > 0 )); then
  for PID in "${PIDS[@]}"; do
    echo "Forzando cierre del proceso trabado: $PID"
    kill -9 "$PID" 2>/dev/null
  done
  sleep 1
fi

echo ""
echo "2/4 Verificando Node.js..."
NODE_PATH="$(command -v node)"
if [[ "$NODE_PATH" == *"/script/alias/node" && -x "/Applications/ServBay/bin/node" ]]; then
  NODE_PATH="/Applications/ServBay/bin/node"
fi
if [[ ! -x "$NODE_PATH" && -x "/Applications/ServBay/bin/node" ]]; then
  NODE_PATH="/Applications/ServBay/bin/node"
fi

if [[ ! -x "$NODE_PATH" ]]; then
  echo "No encontré Node.js para arrancar el CRM."
  echo "Instalá Node.js o ServBay y volvé a intentar."
  echo ""
  read -k 1 "?Presioná cualquier tecla para cerrar..."
  exit 1
fi

echo "Node: $NODE_PATH"
echo ""
echo "3/4 Revisando archivos del CRM..."
"$NODE_PATH" --check server.js
"$NODE_PATH" --check app.js
if [[ "$?" != "0" ]]; then
  echo "Hay un error en los archivos del CRM. Copiá el mensaje de arriba."
  echo ""
  read -k 1 "?Presioná cualquier tecla para cerrar..."
  exit 1
fi

echo ""
echo "4/4 Arrancando servidor..."
if [[ -f "$PLIST" ]]; then
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  launchctl enable "gui/$(id -u)/com.ditaranto.crm"
  launchctl kickstart -k "gui/$(id -u)/com.ditaranto.crm"
else
  mkdir -p "$PROJECT_DIR/logs"
  HOST=0.0.0.0 PORT="$PORT" "$NODE_PATH" server.js > "$PROJECT_DIR/logs/crm.out.log" 2> "$PROJECT_DIR/logs/crm.err.log" &
fi

sleep 2
if ! curl -s "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "El servidor no respondió todavía."
  echo "Último error:"
  tail -20 "$PROJECT_DIR/logs/crm.err.log" 2>/dev/null
  echo ""
  read -k 1 "?Presioná cualquier tecla para cerrar..."
  exit 1
fi

echo ""
echo "Listo. El CRM está funcionando."
echo ""
echo "Mac:"
echo "http://127.0.0.1:$PORT"
echo ""
IP="$(ipconfig getifaddr en0 2>/dev/null)"
if [ -z "$IP" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null)"
fi
if [ -n "$IP" ]; then
  echo "iPhone:"
  echo "http://$IP:$PORT/celular"
fi
echo ""
open "http://127.0.0.1:$PORT"
echo "Ya podés cerrar esta ventana cuando quieras."
read -k 1 "?Presioná cualquier tecla para cerrar..."
