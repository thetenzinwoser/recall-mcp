import { z } from 'zod';
import { indexStrategyDocs } from '../services/indexer.js';
import { getCountsBySourceType } from '../services/vectordb.js';
import { indexGranolaTranscripts, indexWisprTranscripts } from '../services/transcript-indexer.js';

const indexTranscriptsSchema = z.object({
  limit: z.number().min(1).optional(),
  clearExisting: z.boolean().optional().default(false),
});

export async function reindexStrategyDocs(): Promise<string> {
  console.error('Starting reindex of strategy documents...');

  const result = await indexStrategyDocs();

  const response = [
    'Strategy docs reindex completed!',
    '',
    `Files indexed: ${result.filesIndexed}`,
    `Chunks created: ${result.chunksCreated}`,
    `Duration: ${(result.durationMs / 1000).toFixed(2)}s`,
  ].join('\n');

  return response;
}

export async function indexTranscripts(args: unknown): Promise<string> {
  const input = indexTranscriptsSchema.parse(args);

  console.error('Starting Granola transcript indexing...');

  const result = await indexGranolaTranscripts({
    limit: input.limit,
    clearExisting: input.clearExisting,
  });

  const response = [
    'Transcript indexing completed!',
    '',
    `Meetings processed: ${result.meetingsProcessed}`,
    `Meetings skipped (no transcript): ${result.meetingsSkipped}`,
    `Meetings already indexed: ${result.meetingsAlreadyIndexed}`,
    `Chunks created: ${result.chunksCreated}`,
    `Duration: ${(result.durationMs / 1000).toFixed(2)}s`,
  ].join('\n');

  return response;
}

export async function indexWispr(): Promise<string> {
  console.error('Starting Wispr Flow transcript indexing...');

  const result = await indexWisprTranscripts();

  const response = [
    'Wispr transcript indexing completed!',
    '',
    `Meetings processed: ${result.meetingsProcessed}`,
    `Meetings skipped (no transcript): ${result.meetingsSkipped}`,
    `Meetings already indexed: ${result.meetingsAlreadyIndexed}`,
    `Chunks created: ${result.chunksCreated}`,
    `Transcripts exported: ${result.transcriptsExported}`,
    `Duration: ${(result.durationMs / 1000).toFixed(2)}s`,
  ].join('\n');

  return response;
}

export async function getIndexStatus(): Promise<string> {
  const counts = await getCountsBySourceType();
  const total = counts['strategy-doc'] + counts['granola-transcript'] + counts['wispr-transcript'];

  const response = [
    'Index Status:',
    '',
    `Strategy docs: ${counts['strategy-doc']} chunks`,
    `Granola transcripts: ${counts['granola-transcript']} chunks`,
    `Wispr transcripts: ${counts['wispr-transcript']} chunks`,
    `Total: ${total} chunks`,
  ].join('\n');

  return response;
}

export const reindexDocs = reindexStrategyDocs;

export const reindexTool = {
  name: 'reindex_docs',
  description:
    'Rebuild the vector index for strategy documents. Only affects strategy docs, preserves any indexed transcripts.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: reindexStrategyDocs,
};

export const indexTranscriptsTool = {
  name: 'index_granola_transcripts',
  description:
    'Index Granola meeting transcripts for semantic search. By default, this is additive - only indexes new meetings not already in the index. Use clearExisting to rebuild from scratch.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description:
          'Maximum number of meetings to index. Omit to index all available meetings.',
      },
      clearExisting: {
        type: 'boolean',
        description:
          'If true, clears all existing transcript chunks before indexing. Default: false (additive)',
      },
    },
    required: [],
  },
  handler: indexTranscripts,
};

export const statusTool = {
  name: 'index_status',
  description:
    'Check the current status of the document index, including breakdown by source type (strategy docs vs transcripts).',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: getIndexStatus,
};
