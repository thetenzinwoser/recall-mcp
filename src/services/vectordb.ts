import { ChromaClient, Collection, IncludeEnum } from 'chromadb';
import { CONFIG } from '../config/config.js';

let chromaClient: ChromaClient | null = null;
let collection: Collection | null = null;

async function getClient(): Promise<ChromaClient> {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      path: 'http://localhost:8000',
    });
  }
  return chromaClient;
}

export async function getCollection(): Promise<Collection> {
  if (!collection) {
    const client = await getClient();
    collection = await client.getOrCreateCollection({
      name: CONFIG.collectionName,
      metadata: { description: 'recall strategy docs and transcripts' },
    });
  }
  return collection;
}

export type SourceType = 'strategy-doc' | 'granola-transcript';

export interface DocumentChunk {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    sourceType: SourceType;
    chunkIndex: number;
    startChar: number;
    endChar: number;
    // Strategy doc specific
    filePath?: string;
    fileMtime?: number;
    // Granola transcript specific
    meetingId?: string;
    meetingTitle?: string;
    meetingDate?: string;
  };
}

export async function addDocuments(chunks: DocumentChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  const coll = await getCollection();

  await coll.upsert({
    ids: chunks.map(c => c.id),
    embeddings: chunks.map(c => c.embedding),
    documents: chunks.map(c => c.text),
    metadatas: chunks.map(c => c.metadata),
  });
}

export interface SearchResult {
  id: string;
  text: string;
  sourceType: SourceType;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  distance: number;
  filePath?: string;
  meetingId?: string;
  meetingTitle?: string;
  meetingDate?: string;
}

export interface SearchOptions {
  limit?: number;
  sourceTypes?: SourceType[];
  afterDate?: string;  // ISO date YYYY-MM-DD, inclusive
  beforeDate?: string; // ISO date YYYY-MM-DD, inclusive
}

export async function searchSimilar(
  embedding: number[],
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 5, sourceTypes, afterDate, beforeDate } = options;
  const coll = await getCollection();

  const conditions: Record<string, unknown>[] = [];

  if (sourceTypes && sourceTypes.length > 0) {
    conditions.push({ sourceType: sourceTypes.length === 1 ? sourceTypes[0] : { $in: sourceTypes } });
  } else if (afterDate || beforeDate) {
    // Date filters only apply to transcripts - scope implicitly
    conditions.push({ sourceType: 'granola-transcript' });
  }

  if (afterDate) conditions.push({ meetingDate: { $gte: afterDate } });
  if (beforeDate) conditions.push({ meetingDate: { $lte: beforeDate } });

  const whereFilter = conditions.length === 0
    ? undefined
    : conditions.length === 1
      ? conditions[0]
      : { $and: conditions };

  const results = await coll.query({
    queryEmbeddings: [embedding],
    nResults: limit,
    include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    where: whereFilter as Record<string, unknown>,
  });

  if (!results.ids[0] || results.ids[0].length === 0) {
    return [];
  }

  return results.ids[0].map((id, i) => {
    const meta = results.metadatas?.[0]?.[i] as Record<string, unknown> || {};
    return {
      id,
      text: results.documents?.[0]?.[i] || '',
      sourceType: (meta.sourceType as SourceType) || 'strategy-doc',
      chunkIndex: (meta.chunkIndex as number) || 0,
      startChar: (meta.startChar as number) || 0,
      endChar: (meta.endChar as number) || 0,
      distance: results.distances?.[0]?.[i] || 0,
      filePath: meta.filePath as string | undefined,
      meetingId: meta.meetingId as string | undefined,
      meetingTitle: meta.meetingTitle as string | undefined,
      meetingDate: meta.meetingDate as string | undefined,
    };
  });
}

export async function clearCollection(): Promise<void> {
  const client = await getClient();

  try {
    await client.deleteCollection({ name: CONFIG.collectionName });
  } catch {
    // Collection might not exist
  }

  collection = null;
}

export async function getCollectionCount(): Promise<number> {
  const coll = await getCollection();
  return await coll.count();
}

export async function deleteBySourceType(sourceType: SourceType): Promise<number> {
  const coll = await getCollection();

  const results = await coll.get({
    where: { sourceType },
    include: [],
  });

  if (results.ids.length === 0) {
    return 0;
  }

  await coll.delete({ ids: results.ids });
  return results.ids.length;
}

export async function getCountsBySourceType(): Promise<Record<SourceType, number>> {
  const coll = await getCollection();

  const strategyDocs = await coll.get({
    where: { sourceType: 'strategy-doc' },
    include: [],
  });

  const transcripts = await coll.get({
    where: { sourceType: 'granola-transcript' },
    include: [],
  });

  return {
    'strategy-doc': strategyDocs.ids.length,
    'granola-transcript': transcripts.ids.length,
  };
}

export async function getIndexedMeetingIds(): Promise<Set<string>> {
  const coll = await getCollection();

  const results = await coll.get({
    where: { sourceType: 'granola-transcript' },
    include: [IncludeEnum.Metadatas],
  });

  const meetingIds = new Set<string>();
  for (const meta of results.metadatas || []) {
    const meetingId = (meta as Record<string, unknown>)?.meetingId as string;
    if (meetingId) {
      meetingIds.add(meetingId);
    }
  }

  return meetingIds;
}

export async function getIndexedStrategyDocs(): Promise<Map<string, number>> {
  const coll = await getCollection();

  const results = await coll.get({
    where: { sourceType: 'strategy-doc' },
    include: [IncludeEnum.Metadatas],
  });

  const fileMap = new Map<string, number>();
  for (const meta of results.metadatas || []) {
    const filePath = (meta as Record<string, unknown>)?.filePath as string;
    const fileMtime = (meta as Record<string, unknown>)?.fileMtime as number;
    if (filePath && fileMtime && !fileMap.has(filePath)) {
      fileMap.set(filePath, fileMtime);
    }
  }

  return fileMap;
}

export async function deleteByFilePaths(filePaths: string[]): Promise<number> {
  if (filePaths.length === 0) return 0;

  const coll = await getCollection();
  let totalDeleted = 0;

  for (const filePath of filePaths) {
    const results = await coll.get({
      where: { filePath },
      include: [],
    });

    if (results.ids.length > 0) {
      await coll.delete({ ids: results.ids });
      totalDeleted += results.ids.length;
    }
  }

  return totalDeleted;
}
