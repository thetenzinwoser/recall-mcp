#!/bin/bash
# Auto-index wrapper script for launchd
# Uses absolute paths since launchd has a minimal environment

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

RECALL_MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$RECALL_MCP_DIR"

# Load .env if it exists
if [ -f "$RECALL_MCP_DIR/.env" ]; then
  set -a
  source "$RECALL_MCP_DIR/.env"
  set +a
fi

# Log output
LOG_FILE="$RECALL_MCP_DIR/logs/auto-index.log"
mkdir -p "$RECALL_MCP_DIR/logs"
# One run at a time: a classifier backfill can take hours, and launchd fires
# every 15 minutes. A stale lock (dead pid) is cleared automatically.
LOCK_DIR="$RECALL_MCP_DIR/logs/.auto-index.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK_DIR/pid" 2>/dev/null)" 2>/dev/null; then
    echo "[$(date)] Auto-index already running (pid $(cat "$LOCK_DIR/pid")), skipping" >> "$LOG_FILE"
    exit 0
  fi
  rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR"
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

echo "[$(date)] Auto-index starting..." >> "$LOG_FILE"
"$RECALL_MCP_DIR/node_modules/.bin/tsx" src/scripts/auto-index.ts >> "$LOG_FILE" 2>&1
echo "[$(date)] Auto-index finished (exit: $?)" >> "$LOG_FILE"
