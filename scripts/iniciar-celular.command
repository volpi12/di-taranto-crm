#!/bin/zsh
cd "$(dirname "$0")/.."

NODE_PATH="$(command -v node)"
if [[ "$NODE_PATH" == *"/script/alias/node" && -x "/Applications/ServBay/bin/node" ]]; then
  NODE_PATH="/Applications/ServBay/bin/node"
fi
if [[ ! -x "$NODE_PATH" && -x "/Applications/ServBay/bin/node" ]]; then
  NODE_PATH="/Applications/ServBay/bin/node"
fi

if [[ ! -x "$NODE_PATH" ]]; then
  echo "No encontré Node.js para arrancar el CRM."
  echo "Abrí el CRM desde la Mac o instalá Node/ServBay."
  echo ""
  read -k 1 "?Presioná cualquier tecla para cerrar..."
  exit 1
fi

PORT="5200"
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT="$((PORT + 1))"
done

IPS=("${(@f)$(ifconfig | awk '/^[a-z0-9]+:/{iface=$1} /inet / && $2 !~ /^127[.]/ {gsub(":","",iface); print $2}')}")
LOCAL_NAME="$(scutil --get LocalHostName 2>/dev/null)"

echo "Ditaranto CRM - modo celular limpio"
echo ""
echo "Abrí una de estas direcciones desde Safari/Chrome del celular:"
echo ""
if [ -n "$LOCAL_NAME" ]; then
  echo "http://$LOCAL_NAME.local:$PORT/celular"
fi
for IP in "${IPS[@]}"; do
  echo "http://$IP:$PORT/celular"
done
echo ""
echo "Reglas:"
echo "- Mac y celular en la misma WiFi o hotspot."
echo "- No uses 127.0.0.1 en el celular."
echo "- Primero probalo en Safari/Chrome. Agregalo a pantalla de inicio recién cuando abra."
echo "- Si tenías un ícono viejo, borralo."
echo ""

echo "Arrancando CRM en modo celular..."
echo ""
HOST=0.0.0.0 PORT="$PORT" "$NODE_PATH" server.js

echo ""
echo "El servidor se cerró. Si hubo error, copiá el mensaje de arriba."
read -k 1 "?Presioná cualquier tecla para cerrar..."
