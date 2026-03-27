import { chunkText } from '../utils/chunker.js';
import { getEmbeddings } from './embeddings.js';
import {
  addDocuments,
  deleteBySourceType,
  getIndexedMeetingIds,
  DocumentChunk,
} from './vectordb.js';
import {
  listMeetings,
  getTranscript,
  GranolaTranscript,
} from './granola-api.js';
import {
  exportTranscripts,
} from './transcript-exporter.js';

export interface IndexTranscriptsOptions {
  meetingIds?: string[];
  limit?: number;
  clearExisting?: boolean;
  exportMarkdown?: boolean;
  exportPath?: string;
}

export interface IndexTranscriptsResult {
  meetingsProcessed: number;
  meetingsSkipped: number;
  meetingsAlreadyIndexed: number;
  chunksCreated: number;
  transcriptsExported: number;
  exportPath?: string;
  durationMs: number;
}

export async function indexGranolaTranscripts(
  options: IndexTranscriptsOptions = {}
): Promise<IndexTranscriptsResult> {
  const { meetingIds, limit, clearExisting = false, exportMarkdown = true, exportPath } = options;
  const startTime = Date.now();

  if (clearExisting) {
    console.error('Clearing existing transcript chunks...');
    const deleted = await deleteBySourceType('granola-transcript');
    console.error(`Deleted ${deleted} existing transcript chunks`);
  }

  const indexedMeetingIds = clearExisting
    ? new Set<string>()
    : await getIndexedMeetingIds();

  console.error(`Already indexed: ${indexedMeetingIds.size} meetings`);

  console.error('Fetching meeting list from Granola...');
  let meetings = await listMeetings();
  console.error(`Found ${meetings.length} total meetings in Granola`);

  if (meetingIds && meetingIds.length > 0) {
    const idSet = new Set(meetingIds);
    meetings = meetings.filter((m) => idSet.has(m.id));
    console.error(`Filtered to ${meetings.length} specified meetings`);
  }

  if (limit && limit > 0) {
    meetings = meetings.slice(0, limit);
    console.error(`Limited to ${meetings.length} meetings`);
  }

  const meetingsToIndex = meetings.filter((m) => !indexedMeetingIds.has(m.id));
  const alreadyIndexedCount = meetings.length - meetingsToIndex.length;

  console.error(
    `Meetings to index: ${meetingsToIndex.length} (${alreadyIndexedCount} already indexed)`
  );

  let meetingsProcessed = 0;
  let meetingsSkipped = 0;
  let totalChunks = 0;
  const embeddingBatchSize = 20;
  const fetchedTranscripts: GranolaTranscript[] = [];

  for (let i = 0; i < meetingsToIndex.length; i++) {
    const meeting = meetingsToIndex[i];

    try {
      const transcript = await getTranscript(
        meeting.id,
        meeting.title,
        meeting.createdAt.split('T')[0]
      );

      if (!transcript || !transcript.content.trim()) {
        meetingsSkipped++;
        continue;
      }

      const chunks = chunkText(transcript.content);

      for (
        let chunkStart = 0;
        chunkStart < chunks.length;
        chunkStart += embeddingBatchSize
      ) {
        const chunkBatch = chunks.slice(
          chunkStart,
          chunkStart + embeddingBatchSize
        );

        const embeddings = await getEmbeddings(chunkBatch.map((c) => c.text));

        const documents: DocumentChunk[] = chunkBatch.map((chunk, idx) => ({
          id: `granola:${transcript.meetingId}:${chunkStart + idx}`,
          text: chunk.text,
          embedding: embeddings[idx],
          metadata: {
            sourceType: 'granola-transcript' as const,
            meetingId: transcript.meetingId,
            meetingTitle: transcript.meetingTitle,
            meetingDate: transcript.meetingDate,
            chunkIndex: chunkStart + idx,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
          },
        }));

        await addDocuments(documents);
        totalChunks += documents.length;
      }

      fetchedTranscripts.push(transcript);
      meetingsProcessed++;

      if ((i + 1) % 5 === 0 || i === meetingsToIndex.length - 1) {
        console.error(
          `Indexed ${i + 1}/${meetingsToIndex.length} meetings (${totalChunks} chunks total)`
        );
      }

      if (i < meetingsToIndex.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error processing meeting ${meeting.id}:`, error);
      meetingsSkipped++;
    }
  }

  let transcriptsExported = 0;
  let finalExportPath: string | undefined;

  if (exportMarkdown && fetchedTranscripts.length > 0) {
    console.error(`Exporting ${fetchedTranscripts.length} transcripts to markdown...`);
    const exportResult = await exportTranscripts(fetchedTranscripts, { exportPath });
    transcriptsExported = exportResult.exported;
    finalExportPath = exportResult.exportPath;
    console.error(`Exported ${exportResult.exported} transcripts to ${exportResult.exportPath}`);
  }

  const durationMs = Date.now() - startTime;

  return {
    meetingsProcessed,
    meetingsSkipped,
    meetingsAlreadyIndexed: alreadyIndexedCount,
    chunksCreated: totalChunks,
    transcriptsExported,
    exportPath: finalExportPath,
    durationMs,
  };
}
