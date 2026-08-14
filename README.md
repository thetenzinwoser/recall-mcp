# recall-mcp

> **TL;DR:** Local semantic search MCP server over four sources - your markdown docs, Granola meeting transcripts, Wispr Flow transcripts, and your own past Claude Code sessions. Ask Claude "what did we decide about X?" and it finds relevant content by meaning. Runs entirely on your machine - no API keys, no cloud, no cost.

Give Claude Code long-term memory over your notes, meetings, and past conversations with itself. It searches by meaning, runs locally, and costs nothing.

---

## What this is

A [Model Context Protocol](https://modelcontextprotocol.io/) server that indexes four sources into a local vector database: your markdown files, Granola meeting transcripts, Wispr Flow transcripts, and the dialogue from your own past Claude Code sessions. Claude Code can then search across everything by meaning, not just keywords.

You ask something like "what did we decide about the onboarding flow?" and it surfaces relevant chunks from your docs, meeting recordings, and prior conversations, even if those exact words never appeared.

**How it works:**

```
Markdown docs + Granola + Wispr Flow + Claude Code sessions
           |
           v
  Ollama (nomic-embed-text)    <- local embedding model, no API key
           |
           v
       ChromaDB                <- local vector database on localhost:8000
           |
           v
    7 MCP tools                <- Claude Code calls these during conversations
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

### Works with

recall-mcp uses the standard MCP stdio transport, so it works with any MCP-compatible client:

| Client | Config file |
|--------|------------|
| **Claude Code** (CLI) | `~/.claude.json` |
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Cursor** | Cursor settings > MCP |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |

The MCP config block is the same across all of them. This README uses Claude Code as the example, but the server doesn't care which client connects to it.

> **Note:** Setup requires comfort with the terminal, or the ability to point your AI tool at this repo and ask it to set things up for you. For example, you can paste this README into Claude Code or Claude Desktop and ask it to clone the repo and run the setup script on your behalf.

---

## Sources

recall-mcp indexes four kinds of content. Each is tagged with a `sourceType` so you can filter a search to just one kind (`semantic_search` accepts a `sourceTypes` filter). Every source is optional - if you don't have Granola, Wispr, or Claude Code sessions, doc indexing still works on its own.

| Source | `sourceType` | Where it comes from |
|--------|-------------|---------------------|
| Markdown docs | `strategy-doc` | Your `DOCS_PATH` folder, scanned recursively |
| Granola meetings | `granola-transcript` | Granola desktop app's local data |
| Wispr Flow meetings | `wispr-transcript` | Wispr Flow's local transcripts (speaker-attributed). Granola dedups against these. |
| Claude Code sessions | `claude-session` | Your own past conversations in `~/.claude/projects/` |

### Claude Code session capture

This is the source most people won't have seen before, so here's exactly how it works.

Claude Code stores every session as a JSONL file under `~/.claude/projects/<project-slug>/<session-id>.jsonl`, one JSON object per line. recall-mcp reads those files and indexes the **dialogue only** - the actual back-and-forth between you and Claude. Everything else is dropped:

- **Tool calls and tool results** are skipped - they're mostly file dumps already indexed as your docs, and they'd bury the real conversation in noise.
- **Thinking blocks** are skipped.
- **Subagent sidechains** (`isSidechain`) are skipped - only the main conversation is kept.
- **Harness noise** is stripped from your messages: `<system-reminder>` blocks, slash-command wrapper tags, system notifications, interrupt markers, and `local-command-stdout` are all removed before indexing.

What's left is rendered as a clean `User:` / `Claude:` transcript, chunked, embedded, and stored. Each session is titled `[project/path] <title>`, using the session's custom title, then its AI-generated title, then the first user message as a fallback. Sessions with less than 500 characters of real dialogue are dropped as too thin to be useful.

Indexing is **incremental by file mtime** - unchanged sessions are skipped, and a changed session has its old chunks replaced wholesale. Sessions that were active in the **last hour are deferred** so an in-progress conversation isn't re-embedded every cycle; it gets picked up once it goes quiet.

The project-slug directory name (e.g. `-Users-tenzin-Strategy-projects-apollo`) is converted back to a readable path (`Strategy/projects/apollo`) for the title, so search results tell you which project a conversation came from.

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
- Run an initial index across all available sources (docs, Granola, Wispr Flow, Claude Code sessions)
- Print the MCP config block to paste into Claude Code

### 4. Add to your MCP client

Add this to your client's MCP config (see the "Works with" table above for file locations):

```json
"recall": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/recall-mcp/dist/server.js"]
}
```

Use the exact path printed at the end of `setup.sh`. Then restart your client. In Claude Code, run `/mcp` to confirm it connected.

---

## Tools

| Tool | What it does |
|------|-------------|
| `semantic_search` | Search all sources by meaning. Accepts `query`, optional `limit` (1-20), optional `sourceTypes` filter (`strategy-doc`, `granola-transcript`, `wispr-transcript`, `claude-session`). |
| `get_transcript` | Fetch a full meeting transcript. Accepts `meetingId`, `searchTitle` (with optional `date`), or `listRecent`. |
| `reindex_docs` | Re-scan your docs folder. Incremental - only processes changed files. |
| `index_granola_transcripts` | Pull and index new Granola meetings. Accepts `limit` and `clearExisting`. |
| `index_wispr_transcripts` | Index new Wispr Flow transcripts (speaker-attributed). Additive; also exports them to markdown. |
| `index_claude_sessions` | Index dialogue from past Claude Code sessions. Additive and incremental; sessions active in the last hour are deferred. |
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
