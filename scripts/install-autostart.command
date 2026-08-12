#!/bin/zsh
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.ditaranto.crm.plist"
NODE_PATH="$(command -v node)"

if [[ "$NODE_PATH" == *"/script/alias/node" && -x "/Applications/ServBay/bin/node" ]]; then
  NODE_PATH="/Applications/ServBay/bin/node"
fi

if [[ ! -x "$NODE_PATH" ]]; then
  echo "No encontré Node.js ejecutable. Instalá Node o ServBay y volvé a intentar."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.ditaranto.crm</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$PROJECT_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key>
    <string>0.0.0.0</string>
    <key>PORT</key>
    <string>5173</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/logs/crm.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/logs/crm.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.ditaranto.crm"
launchctl kickstart -k "gui/$(id -u)/com.ditaranto.crm"

echo "Ditaranto CRM instalado para iniciar automáticamente."
echo "URL Mac: http://127.0.0.1:5173"
IP="$(ipconfig getifaddr en0 2>/dev/null)"
if [ -z "$IP" ]; then
  IP="$(ipconfig getifaddr en1 2>/dev/null)"
fi
if [ -n "$IP" ]; then
  echo "URL celular: http://$IP:5173/celular"
fi
