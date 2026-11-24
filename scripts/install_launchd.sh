#!/usr/bin/env bash
set -euo pipefail

# Installs an always-on macOS launchd user agent so MCX & NSE Auto-Pilot
# starts automatically on login/wake and restarts within 5s if it ever exits.
APP_DIR="/Users/tonyvelloor/mcx-signal-engine"
NODE_BIN="$(command -v node)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.mcx.signalengine.plist"
LOG_DIR="$APP_DIR/logs"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcx.signalengine</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${APP_DIR}/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>PORT</key>
    <string>8000</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.stderr.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/com.mcx.signalengine" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/com.mcx.signalengine"

echo "✅ Installed & started macOS launchd agent: $PLIST_PATH"
echo "   Node: $NODE_BIN | Logs: $LOG_DIR/server.stdout.log"
