# recall-mcp

> **TL;DR:** Local semantic search MCP server for markdown docs and Granola meeting transcripts. Ask Claude "what did we decide about X?" and it finds relevant content by meaning. Runs entirely on your machine - no API keys, no cloud, no cost.

Give Claude Code long-term memory over your notes and meetings. It searches by meaning, runs locally, and costs nothing.

---

## What this is

A [Model Context Protocol](https://modelcontextprotocol.io/) server that indexes your markdown files and Granola meeting transcripts into a local vector database. Claude Code can then search across everything by meaning, not just keywords.

You ask something like "what did we decide about the onboarding flow?" and it surfaces relevant chunks from your docs and meeting recordings, even if those exact words never appeared.

**How it works:**

```
Your markdown files + Granola meetings
           |
           v
  Ollama (nomic-embed-text)    <- local embedding model, no API key
           |
           v
       ChromaDB                <- local vector database on localhost:8000
           |
           v
    5 MCP tools                <- Claude Code calls these during conversations
```

Auto-indexing runs every 15 minutes in the background via a macOS LaunchAgent.

### Example

You ask Claude Code: *"what did we decide about the onboarding flow?"*

recall-mcp searches your docs and meeting transcripts by meaning and returns the relevant chunks:

```
Source: meetings/product-sync-2026-03-14.md (similarity: 0.82)
"We agreed to cut the walkthrough video and ship a checklist instead.
Jamie owns the copy, targeting next sprint."

Source: docs/onboarding/decisions.md (similarity: 0.79)
"Checklist approach approved — three steps max, no modal,
inline in the dashboard."
```

Claude uses these results to answer your question with the actual context from your notes and meetings.

---

## Prerequisites

- **macOS** (LaunchAgent setup is macOS-specific; the core server works anywhere)
- **Node.js 18+** - `brew install node`
- **Ollama** - [ollama.com](https://ollama.com) or `brew install ollama`
- **uv** (for running ChromaDB) - `brew install uv`
- **Granola** desktop app - [granola.ai](https://granola.ai) - only needed if you want meeting transcript search

---

## Setup

### 1. Clone and build

```bash
git clone https://github.com/thetenzinwoser/recall-mcp.git
cd recall-mcp
npm install
npm run build
```

### 2. Install the embedding model

```bash
brew services start ollama
ollama pull nomic-embed-text
```

First pull is ~274MB. After that it's cached.

### 3. Run setup

```bash
./scripts/setup.sh
```

This will:
- Ask where your markdown docs live (`DOCS_PATH`)
- Write a `.env` file
- Generate LaunchAgent plists from templates and load them
- Start ChromaDB and schedule auto-indexing
- Run an initial index of your docs and Granola transcripts
- Print the MCP config block to paste into Claude Code

### 4. Add to Claude Code

Open `~/.claude.json` and add under `mcpServers`:

```json
"recall": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/recall-mcp/dist/server.js"]
}
```

Use the exact path printed at the end of `setup.sh`. Then restart Claude Code and run `/mcp` to confirm it connected.

---

## Tools

| Tool | What it does |
|------|-------------|
| `semantic_search` | Search docs and transcripts by meaning. Accepts `query`, optional `limit` (1-20), optional `sourceTypes` filter. |
| `get_transcript` | Fetch a full meeting transcript. Accepts `meetingId`, `searchTitle` (with optional `date`), or `listRecent`. |
| `reindex_docs` | Re-scan your docs folder. Incremental - only processes changed files. |
| `index_granola_transcripts` | Pull and index new Granola meetings. Accepts `limit` and `clearExisting`. |
| `index_status` | Show chunk counts by source type. |

### get_transcript details

- **Title search with date:** `{ searchTitle: "team sync March 14" }` - extracts the date and fuzzy-matches the title
- **Explicit date:** `{ searchTitle: "team sync", date: "2026-03-14" }` - when multiple meetings share a title
- **Partial ID:** First 8 characters of a meeting UUID is enough
- **List recent:** `{ listRecent: 20 }` to browse recent meetings with IDs

---

## Configuration

All settings have sensible defaults. The only one most people need is `DOCS_PATH`.

Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOCS_PATH` | `~/docs` | Folder to scan for markdown files (recursive) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Model to use for embeddings |

ChromaDB runs on `localhost:8000` by default. This is not configurable without editing the LaunchAgent plist directly.

---

## Granola integration

recall-mcp reads your Granola auth token from the Granola desktop app's local data. No separate API key or login needed - just have Granola installed and signed in.

Auth token location: `~/Library/Application Support/Granola/supabase.json`

If you don't use Granola, the doc indexing still works fine. Transcript-related tools will return errors, which Claude handles gracefully.

---

## Manual commands

**Reindex now (instead of waiting for the 15-min interval):**
```bash
cd /path/to/recall-mcp && npx tsx src/scripts/auto-index.ts
```

**Check ChromaDB is running:**
```bash
curl -s http://localhost:8000/api/v2/heartbeat
```

**Check what's indexed:**
```bash
# Use the index_status MCP tool, or check logs:
tail -f /path/to/recall-mcp/logs/auto-index.log
```

**Rebuild after pulling updates:**
```bash
npm run build
```

**Restart ChromaDB:**
```bash
launchctl unload ~/Library/LaunchAgents/com.recall.chromadb.plist
launchctl load ~/Library/LaunchAgents/com.recall.chromadb.plist
```

---

## Troubleshooting

**`semantic_search` returns nothing / MCP not connecting**
- Run `/mcp` in Claude Code to check server status
- Make sure `dist/server.js` exists (`npm run build`)
- Verify the path in `~/.claude.json` is absolute and correct

**ChromaDB not running**
```bash
curl -s http://localhost:8000/api/v2/heartbeat
# Should return: {"nanosecond heartbeat": ...}
```
If it fails, check `logs/chromadb-stderr.log` or reload the LaunchAgent.

**Ollama errors**
```bash
ollama list
# nomic-embed-text should appear
```
If not: `ollama pull nomic-embed-text`

**Granola auth fails**
Make sure the Granola desktop app is installed and you're logged in. The token file should exist at `~/Library/Application Support/Granola/supabase.json`.

**Results feel stale**
Force a reindex: `npx tsx src/scripts/auto-index.ts`. The auto-indexer only picks up file changes and new meetings - if you renamed files or restructured folders, a manual run helps.

---

## Stack

| Component | Version | Purpose |
|-----------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.27.0 | MCP server framework |
| `chromadb` | ^1.10.0 | Vector database client |
| `ollama` (nomic-embed-text) | - | Local embeddings, 768 dimensions |
| `glob` | ^10.0.0 | File scanning |
| `zod` | ^3.23.8 | Config validation |

---

## License

MIT
