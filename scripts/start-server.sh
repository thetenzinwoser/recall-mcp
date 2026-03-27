#!/bin/bash
# MCP server entrypoint - kills orphaned recall-mcp processes before starting.
# Orphaned processes (whose parent conversation closed) get reparented to PID 1.
# Active servers still have a live Claude Code parent, so they're left alone.

RECALL_MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env if present
if [ -f "$RECALL_MCP_DIR/.env" ]; then
  set -a
  source "$RECALL_MCP_DIR/.env"
  set +a
fi

# Kill orphaned server processes (PPID=1 means parent exited)
pgrep -f "recall-mcp/dist/server.js" | while read -r pid; do
  ppid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
  if [ "$ppid" = "1" ]; then
    kill "$pid" 2>/dev/null
  fi
done

# Start the server (exec replaces this shell - no extra process)
exec node "$RECALL_MCP_DIR/dist/server.js"
