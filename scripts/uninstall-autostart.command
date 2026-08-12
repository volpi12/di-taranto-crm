#!/bin/zsh
PLIST="$HOME/Library/LaunchAgents/com.ditaranto.crm.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "Inicio automático de Ditaranto CRM desinstalado."
