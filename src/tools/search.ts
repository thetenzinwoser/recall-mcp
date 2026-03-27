import { z } from 'zod';
import { getEmbedding } from '../services/embeddings.js';
import { searchSimilar, SourceType } from '../services/vectordb.js';

const sourceTypeEnum = z.enum(['strategy-doc', 'granola-transcript']);

export const searchInputSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  limit: z.number().min(1).max(20).optional().default(5),
  sourceTypes: z.array(sourceTypeEnum).optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export interface SearchResultItem {
  source_type: SourceType;
  excerpt: string;
  similarity_score: number;
  chunk_index: number;
  file_path?: string;
  meeting_id?: string;
  meeting_title?: string;
  meeting_date?: string;
}

export async function semanticSearch(args: unknown): Promise<string> {
  const input = searchInputSchema.parse(args);

  const queryEmbedding = await getEmbedding(input.query);

  const results = await searchSimilar(queryEmbedding, {
    limit: input.limit,
    sourceTypes: input.sourceTypes as SourceType[] | undefined,
  });

  if (results.length === 0) {
    return 'No results found for your query.';
  }

  const groupedResults = new Map<string, typeof results[0]>();

  for (const result of results) {
    const key = result.sourceType === 'strategy-doc'
      ? `doc:${result.filePath}`
      : `transcript:${result.meetingId}`;

    if (!groupedResults.has(key)) {
      groupedResults.set(key, result);
    }
  }

  const formattedResults: SearchResultItem[] = Array.from(groupedResults.values()).map(result => ({
    source_type: result.sourceType,
    excerpt: result.text.slice(0, 300) + (result.text.length > 300 ? '...' : ''),
    similarity_score: Math.round((1 - result.distance) * 100) / 100,
    chunk_index: result.chunkIndex,
    file_path: result.filePath,
    meeting_id: result.meetingId,
    meeting_title: result.meetingTitle,
    meeting_date: result.meetingDate,
  }));

  let response = `Found ${formattedResults.length} relevant result(s) for: "${input.query}"\n\n`;

  formattedResults.forEach((result, i) => {
    if (result.source_type === 'strategy-doc') {
      response += `**${i + 1}. [Doc] ${result.file_path}** (score: ${result.similarity_score})\n`;
    } else {
      response += `**${i + 1}. [Transcript] ${result.meeting_title || 'Untitled'}** (${result.meeting_date || 'No date'}, score: ${result.similarity_score})\n`;
    }
    response += `${result.excerpt}\n\n`;
  });

  return response;
}

export const searchTool = {
  name: 'semantic_search',
  description: 'Search strategy docs and Granola meeting transcripts by meaning, not just keywords. Finds relevant content based on concepts and topics.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The search query - describe what you\'re looking for',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5, max: 20)',
      },
      sourceTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['strategy-doc', 'granola-transcript'],
        },
        description: 'Filter by source type. Omit to search all sources. Use ["strategy-doc"] for docs only, ["granola-transcript"] for transcripts only.',
      },
    },
    required: ['query'],
  },
  handler: semanticSearch,
};
