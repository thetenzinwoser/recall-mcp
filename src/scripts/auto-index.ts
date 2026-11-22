/**
 * Automated daily indexing script
 * Runs both strategy doc and transcript indexing
 * No external dependencies needed - Ollama + embedded ChromaDB
 */

import { indexStrategyDocs } from '../services/indexer.js';
import { indexWisprTranscripts } from '../services/transcript-indexer.js';
import { indexClaudeSessions } from '../services/session-indexer.js';
import { CONFIG } from '../config/config.js';

async function checkOllama(): Promise<boolean> {
  try {
    const response = await fetch(`${CONFIG.ollamaUrl}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting auto-index...`);

  // Check if Ollama is running
  const ollamaReady = await checkOllama();
  if (!ollamaReady) {
    console.error('Ollama is not running. Start it with: brew services start ollama');
    process.exit(1);
  }

  // Index strategy docs (incremental)
  console.log('\n--- Strategy Docs ---');
  try {
    const docsResult = await indexStrategyDocs();
    console.log(`New: ${docsResult.filesNew}, Modified: ${docsResult.filesModified}, Deleted: ${docsResult.filesDeleted}, Unchanged: ${docsResult.filesUnchanged}`);
    console.log(`Chunks created: ${docsResult.chunksCreated}, deleted: ${docsResult.chunksDeleted}`);
  } catch (error) {
    console.error('Strategy doc indexing failed:', error);
  }

  // Index Wispr Flow meetings
  console.log('\n--- Wispr Flow Transcripts ---');
  try {
    const wisprResult = await indexWisprTranscripts();
    console.log(`Processed ${wisprResult.meetingsProcessed} new Wispr meetings`);
    console.log(`Skipped ${wisprResult.meetingsAlreadyIndexed} (already indexed)`);
    console.log(`Created ${wisprResult.chunksCreated} chunks`);
    if (wisprResult.transcriptsExported > 0) {
      console.log(`Exported ${wisprResult.transcriptsExported} transcripts to ${wisprResult.exportPath}`);
    }
  } catch (error) {
    console.error('Wispr transcript indexing failed:', error);
  }

  // Granola indexing removed from the auto run (Nov 22, 2026): no longer using
  // Granola. index_granola_transcripts is still available as a manual MCP tool.

  // Index Claude Code session dialogue (incremental by file mtime)
  console.log('\n--- Claude Code Sessions ---');
  try {
    const sessionResult = await indexClaudeSessions();
    console.log(`Processed ${sessionResult.sessionsProcessed} sessions (${sessionResult.sessionsUpdated} updated)`);
    console.log(`Skipped ${sessionResult.sessionsSkipped}, unchanged ${sessionResult.sessionsAlreadyIndexed}`);
    console.log(`Created ${sessionResult.chunksCreated} chunks`);
  } catch (error) {
    console.error('Claude session indexing failed:', error);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[${new Date().toISOString()}] Auto-index complete in ${duration}s`);
}

main().catch(console.error);
