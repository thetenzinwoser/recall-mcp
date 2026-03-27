/**
 * Automated daily indexing script
 * Runs both strategy doc and transcript indexing
 * No external dependencies needed - Ollama + embedded ChromaDB
 */

import { indexStrategyDocs } from '../services/indexer.js';
import { indexGranolaTranscripts } from '../services/transcript-indexer.js';
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

  // Index recent transcripts (incremental) + export to markdown
  console.log('\n--- Granola Transcripts ---');
  try {
    const transcriptResult = await indexGranolaTranscripts({ limit: 50 });
    console.log(`Processed ${transcriptResult.meetingsProcessed} new meetings`);
    console.log(`Skipped ${transcriptResult.meetingsSkipped} (already indexed)`);
    console.log(`Created ${transcriptResult.chunksCreated} chunks`);
    if (transcriptResult.transcriptsExported > 0) {
      console.log(`Exported ${transcriptResult.transcriptsExported} transcripts to ${transcriptResult.exportPath}`);
    }
  } catch (error) {
    console.error('Transcript indexing failed:', error);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n[${new Date().toISOString()}] Auto-index complete in ${duration}s`);
}

main().catch(console.error);
