#!/bin/zsh
cd "$(dirname "$0")/.."
echo "Iniciando Ditaranto CRM..."
IP="$(ipconfig getifaddr en0 2>/dev/null)"
if [ -z "$IP" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null)"
fi

echo "Abrí en la Mac: http://127.0.0.1:5173"
if [ -n "$IP" ]; then
  echo "Abrí en el celular: http://$IP:5173/celular"
fi
npm start
