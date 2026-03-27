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
echo "[$(date)] Auto-index starting..." >> "$LOG_FILE"
"$RECALL_MCP_DIR/node_modules/.bin/tsx" src/scripts/auto-index.ts >> "$LOG_FILE" 2>&1
echo "[$(date)] Auto-index finished (exit: $?)" >> "$LOG_FILE"
