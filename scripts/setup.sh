#!/bin/bash
# recall-mcp setup script
# Generates LaunchAgent plists from templates and loads them.
# Run this once after cloning and running npm install.

set -e

RECALL_MCP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LAUNCHAGENT_TEMPLATES_DIR="$RECALL_MCP_DIR/launchagents"

echo ""
echo "recall-mcp setup"
echo "================"
echo ""

# ------------------------------------------------------------------
# 1. DOCS_PATH
# ------------------------------------------------------------------
DEFAULT_DOCS="$HOME/docs"

echo "Where are your markdown docs?"
echo "This is the folder recall will index for semantic search."
echo "(default: $DEFAULT_DOCS)"
echo ""
read -r -p "DOCS_PATH: " INPUT_DOCS

DOCS_PATH="${INPUT_DOCS:-$DEFAULT_DOCS}"

# Expand ~ if present
DOCS_PATH="${DOCS_PATH/#\~/$HOME}"

if [ ! -d "$DOCS_PATH" ]; then
  echo ""
  echo "Warning: $DOCS_PATH does not exist yet."
  read -r -p "Create it? [y/N] " CREATE_DOCS
  if [[ "$CREATE_DOCS" =~ ^[Yy]$ ]]; then
    mkdir -p "$DOCS_PATH"
    echo "Created $DOCS_PATH"
  else
    echo "Continuing - you can create it later and trigger a reindex."
  fi
fi

# ------------------------------------------------------------------
# 2. Write .env
# ------------------------------------------------------------------
ENV_FILE="$RECALL_MCP_DIR/.env"
echo ""
echo "Writing $ENV_FILE..."
cat > "$ENV_FILE" <<EOF
DOCS_PATH=$DOCS_PATH
EOF
echo "Done."

# ------------------------------------------------------------------
# 3. Create logs directory
# ------------------------------------------------------------------
mkdir -p "$RECALL_MCP_DIR/logs"
mkdir -p "$RECALL_MCP_DIR/data/chroma"

# ------------------------------------------------------------------
# 4. Generate LaunchAgent plists from templates
# ------------------------------------------------------------------
echo ""
echo "Generating LaunchAgent plists..."

mkdir -p "$LAUNCH_AGENTS_DIR"

for TEMPLATE in "$LAUNCHAGENT_TEMPLATES_DIR"/*.plist.template; do
  BASENAME="$(basename "$TEMPLATE" .template)"
  OUTPUT="$LAUNCH_AGENTS_DIR/$BASENAME"
  sed "s|{{RECALL_MCP_DIR}}|$RECALL_MCP_DIR|g" "$TEMPLATE" > "$OUTPUT"
  echo "  Wrote $OUTPUT"
done

# ------------------------------------------------------------------
# 5. Load LaunchAgents
# ------------------------------------------------------------------
echo ""
echo "Loading LaunchAgents..."

launchctl unload "$LAUNCH_AGENTS_DIR/com.recall.chromadb.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS_DIR/com.recall.chromadb.plist"
echo "  ChromaDB started (localhost:8000)"

launchctl unload "$LAUNCH_AGENTS_DIR/com.recall.auto-index.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS_DIR/com.recall.auto-index.plist"
echo "  Auto-index scheduled (every 15 min)"

# ------------------------------------------------------------------
# 6. Run initial index
# ------------------------------------------------------------------
echo ""
echo "Running initial index (this may take a minute on first run)..."
cd "$RECALL_MCP_DIR"
if [ -f ".env" ]; then
  set -a
  source .env
  set +a
fi
node_modules/.bin/tsx src/scripts/auto-index.ts

# ------------------------------------------------------------------
# 7. Print Claude Code config
# ------------------------------------------------------------------
echo ""
echo "========================================"
echo "Setup complete!"
echo "========================================"
echo ""
echo "Add this to your Claude Code MCP config (~/.claude.json under 'mcpServers'):"
echo ""
echo '  "recall": {'
echo '    "type": "stdio",'
echo '    "command": "node",'
echo "    \"args\": [\"$RECALL_MCP_DIR/dist/server.js\"]"
echo '  }'
echo ""
echo "Then restart Claude Code and run /mcp to verify the connection."
echo ""
echo "ChromaDB health check:"
echo "  curl -s http://localhost:8000/api/v2/heartbeat"
echo ""
echo "Index status:"
echo "  cd $RECALL_MCP_DIR && npx tsx src/scripts/auto-index.ts"
echo ""
