#!/bin/bash
# Run the Mac worker (apps/worker) as a launchd user agent: starts at login, restarts if it dies.
#   deploy/launchd/install.sh            install or reinstall (also after moving the repo or changing PATH)
#   deploy/launchd/install.sh uninstall  stop and remove
# Logs: ~/Library/Logs/kb-worker.log
set -euo pipefail

LABEL=local.kb-worker
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/kb-worker.log"
DOMAIN="gui/$(id -u)"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO/apps/worker/.env"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [ "${1:-}" = uninstall ]; then
  rm -f "$PLIST"
  echo "removed $LABEL"
  exit 0
fi

BUN="$(command -v bun)" || { echo "bun not found on PATH" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (cp apps/worker/.env.example apps/worker/.env)" >&2; exit 1; }

# launchd starts agents with a bare PATH. The worker spawns bun, git, git-crypt and the agent CLI
# (claude/codex/gemini), so capture the PATH of the shell that runs this script.
mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN</string>
    <string>--env-file=$ENV_FILE</string>
    <string>run</string>
    <string>$REPO/apps/worker/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST" >/dev/null

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "installed $LABEL → $PLIST"
echo "logs:    tail -f $LOG"
echo "restart: launchctl kickstart -k $DOMAIN/$LABEL   (after editing .env or pulling new code)"
