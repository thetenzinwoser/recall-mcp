#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { semanticSearch } from './tools/search.js';
import { reindexStrategyDocs, indexTranscripts, indexWispr, indexSessions, getIndexStatus } from './tools/reindex.js';
import { getTranscriptHandler } from './tools/transcript.js';
import { listMeetings } from './tools/meetings.js';

const server = new McpServer({
  name: 'recall',
  version: '2.0.0',
});

// semantic_search
server.tool(
  'semantic_search',
  'Search strategy docs, Wispr meeting transcripts and Claude Code sessions by meaning, not just keywords. Returns the closest matches (top-k), so it is for finding relevant passages, not exhaustive lists; use list_meetings to enumerate every meeting matching a context/person/date. Every source is tagged with a life context: work, mable (side project), therapy, mentorship, personal, or other. Use the context filter whenever the question is about one area.',
  {
    query: z.string().min(1).describe('The search query - describe what you\'re looking for'),
    limit: z.number().min(1).max(20).optional().default(5).describe('Maximum number of results to return (default: 5, max: 20)'),
    sourceTypes: z.array(z.enum(['strategy-doc', 'granola-transcript', 'wispr-transcript', 'claude-session'])).optional().describe('Filter by source type. Omit to search all sources.'),
    afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only return transcripts on or after this date (YYYY-MM-DD). Automatically scopes to transcripts.'),
    beforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Only return transcripts on or before this date (YYYY-MM-DD). Automatically scopes to transcripts.'),
    context: z.enum(['work', 'mable', 'therapy', 'mentorship', 'personal', 'other']).optional().describe('Only return content tagged with this life context (primary or secondary). work = day job, mable = side-project app, therapy = therapy sessions, mentorship = mentoring calls, personal = dating/friends/family/own reflections.'),
    participant: z.string().min(1).optional().describe('Only return Wispr meetings this person spoke in (case-insensitive name match, includes speakers inferred from the transcript). Scopes to Wispr transcripts.'),
  },
  async (args) => {
    const result = await semanticSearch(args);
    return { content: [{ type: 'text', text: result }] };
  }
);

// list_meetings
server.tool(
  'list_meetings',
  'List EVERY Wispr meeting matching the filters (not top-k), newest first, with a one-line summary, life context and participants. Use this for questions like "all my meetings with Sam about the side project last month". Wispr titles are often wrong; trust the summary. Participants marked (inferred) were named by a local model from the transcript, not by Wispr.',
  {
    context: z.enum(['work', 'mable', 'therapy', 'mentorship', 'personal', 'other']).optional().describe('Life context (matches primary or secondary tag).'),
    participant: z.string().min(1).optional().describe('Person who spoke in the meeting (case-insensitive, partial name ok).'),
    afterDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('On or after this date (YYYY-MM-DD).'),
    beforeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('On or before this date (YYYY-MM-DD).'),
    limit: z.number().min(1).max(500).optional().default(100).describe('Max meetings to return (default 100).'),
  },
  async (args) => {
    const result = await listMeetings(args);
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

// index_wispr_transcripts
server.tool(
  'index_wispr_transcripts',
  'Index Wispr Flow meeting transcripts (speaker-attributed) for semantic search. Additive - only indexes new meetings. Also exports new transcripts to markdown.',
  {},
  async () => {
    const result = await indexWispr();
    return { content: [{ type: 'text', text: result }] };
  }
);

// index_claude_sessions
server.tool(
  'index_claude_sessions',
  'Index Claude Code session dialogue (user + assistant text, no tool traffic) for semantic search. Additive and incremental; sessions active in the last hour are deferred.',
  {},
  async () => {
    const result = await indexSessions();
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
