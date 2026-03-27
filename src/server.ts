#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { semanticSearch } from './tools/search.js';
import { reindexStrategyDocs, indexTranscripts, getIndexStatus } from './tools/reindex.js';
import { getTranscriptHandler } from './tools/transcript.js';

const server = new McpServer({
  name: 'recall',
  version: '2.0.0',
});

// semantic_search
server.tool(
  'semantic_search',
  'Search strategy docs and Granola meeting transcripts by meaning, not just keywords. Finds relevant content based on concepts and topics.',
  {
    query: z.string().min(1).describe('The search query - describe what you\'re looking for'),
    limit: z.number().min(1).max(20).optional().default(5).describe('Maximum number of results to return (default: 5, max: 20)'),
    sourceTypes: z.array(z.enum(['strategy-doc', 'granola-transcript'])).optional().describe('Filter by source type. Omit to search all sources.'),
  },
  async (args) => {
    const result = await semanticSearch(args);
    return { content: [{ type: 'text', text: result }] };
  }
);

// reindex_docs
server.tool(
  'reindex_docs',
  'Rebuild the vector index for strategy documents. Only affects strategy docs, preserves any indexed transcripts.',
  {},
  async () => {
    const result = await reindexStrategyDocs();
    return { content: [{ type: 'text', text: result }] };
  }
);

// index_granola_transcripts
server.tool(
  'index_granola_transcripts',
  'Index Granola meeting transcripts for semantic search. By default additive - only indexes new meetings. Use clearExisting to rebuild from scratch.',
  {
    limit: z.number().min(1).optional().describe('Maximum number of meetings to index. Omit to index all.'),
    clearExisting: z.boolean().optional().default(false).describe('If true, clears all existing transcript chunks before indexing.'),
  },
  async (args) => {
    const result = await indexTranscripts(args);
    return { content: [{ type: 'text', text: result }] };
  }
);

// index_status
server.tool(
  'index_status',
  'Check the current status of the document index, including breakdown by source type.',
  {},
  async () => {
    const result = await getIndexStatus();
    return { content: [{ type: 'text', text: result }] };
  }
);

// get_transcript
server.tool(
  'get_transcript',
  'Fetch the full transcript of a Granola meeting. Supports title + date search (e.g., "JT 1:1" + date "2026-03-02"), partial meeting IDs, and listing recent meetings.',
  {
    meetingId: z.string().optional().describe('Granola meeting ID - supports both full UUID and partial prefix (e.g., "3453175f")'),
    searchTitle: z.string().optional().describe('Search by title. Dates in the query are extracted automatically (e.g., "JT March 2"). Returns transcript of best match.'),
    date: z.string().optional().describe('Filter by date (YYYY-MM-DD). Use with searchTitle to disambiguate same-titled meetings.'),
    listRecent: z.number().min(1).max(50).optional().describe('List N most recent meetings with their IDs (1-50).'),
  },
  async (args) => {
    const result = await getTranscriptHandler(args);
    return { content: [{ type: 'text', text: result }] };
  }
);

// Start
async function main(): Promise<void> {
  console.error('Starting Recall MCP Server v2.0.0 (Ollama + embedded ChromaDB)...');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Recall MCP Server running on stdio');
}

main().catch((error: Error) => {
  console.error('Failed to start Recall MCP Server:', error);
  process.exit(1);
});
