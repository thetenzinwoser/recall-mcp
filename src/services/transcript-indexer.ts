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
import {
  getLocalTranscriptMetas,
  LOCAL_TRANSCRIPTS_PATH,
} from './local-transcripts.js';
import {
  listWisprMeetings,
  getWisprTranscript,
  isCoveredByWispr,
  wisprAvailable,
  WisprMeeting,
} from './wispr-transcripts.js';

/**
 * Wispr wins whenever both apps recorded the same meeting. Returns the Wispr
 * meeting list for dedup checks, or [] if Wispr isn't installed.
 */
async function getWisprMeetingsForDedup(): Promise<WisprMeeting[]> {
  try {
    if (!(await wisprAvailable())) return [];
    return await listWisprMeetings();
  } catch (error) {
    console.error('Could not list Wispr meetings for dedup (indexing all Granola):', error);
    return [];
  }
}

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

  const notYetIndexed = meetings.filter((m) => !indexedMeetingIds.has(m.id));
  const alreadyIndexedCount = meetings.length - notYetIndexed.length;

  // Dedup: skip meetings Wispr Flow also recorded (Wispr version is
  // speaker-attributed, so it's the one that gets indexed)
  const wisprMeetings = await getWisprMeetingsForDedup();
  const meetingsToIndex = notYetIndexed.filter((m) => !isCoveredByWispr(m, wisprMeetings));
  const coveredByWispr = notYetIndexed.length - meetingsToIndex.length;
  if (coveredByWispr > 0) {
    console.error(`Skipping ${coveredByWispr} meetings covered by Wispr Flow`);
  }

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

export interface IndexLocalTranscriptsResult {
  meetingsProcessed: number;
  meetingsSkipped: number;
  meetingsAlreadyIndexed: number;
  chunksCreated: number;
  durationMs: number;
}

/**
 * Index transcripts from local markdown files in ~/Documents/granola-transcripts/
 * Works without any API access. Picks up both previously-exported files and any
 * manually-dropped transcripts. Already-indexed meetings are skipped.
 */
export async function indexLocalTranscripts(): Promise<IndexLocalTranscriptsResult> {
  const startTime = Date.now();

  console.error(`Scanning local transcripts at ${LOCAL_TRANSCRIPTS_PATH}...`);
  const localMetas = await getLocalTranscriptMetas();
  console.error(`Found ${localMetas.length} local transcript files`);

  const indexedMeetingIds = await getIndexedMeetingIds();
  const notYetIndexed = localMetas.filter((m) => !indexedMeetingIds.has(m.meetingId));
  const alreadyIndexedCount = localMetas.length - notYetIndexed.length;

  // Dedup: local files carry date-only timestamps, so this matches on
  // date + title against Wispr meetings
  const wisprMeetings = await getWisprMeetingsForDedup();
  const toIndex = notYetIndexed.filter(
    (m) => !isCoveredByWispr({ title: m.title, createdAt: `${m.date}T00:00:00.000Z` }, wisprMeetings)
  );
  const coveredByWispr = notYetIndexed.length - toIndex.length;
  if (coveredByWispr > 0) {
    console.error(`Skipping ${coveredByWispr} local files covered by Wispr Flow`);
  }

  console.error(`To index: ${toIndex.length} (${alreadyIndexedCount} already indexed)`);

  let meetingsProcessed = 0;
  let meetingsSkipped = 0;
  let totalChunks = 0;
  const embeddingBatchSize = 20;
  const fs = await import('fs/promises');

  for (let i = 0; i < toIndex.length; i++) {
    const meta = toIndex[i];
    try {
      const raw = await fs.readFile(meta.filePath, 'utf-8');
      // Strip frontmatter
      const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      const content = bodyMatch ? bodyMatch[1].trim() : raw.trim();

      if (!content) {
        meetingsSkipped++;
        continue;
      }

      const chunks = chunkText(content);

      for (let chunkStart = 0; chunkStart < chunks.length; chunkStart += embeddingBatchSize) {
        const chunkBatch = chunks.slice(chunkStart, chunkStart + embeddingBatchSize);
        const embeddings = await getEmbeddings(chunkBatch.map((c) => c.text));

        const documents: DocumentChunk[] = chunkBatch.map((chunk, idx) => ({
          id: `granola:${meta.meetingId}:${chunkStart + idx}`,
          text: chunk.text,
          embedding: embeddings[idx],
          metadata: {
            sourceType: 'granola-transcript' as const,
            meetingId: meta.meetingId,
            meetingTitle: meta.title,
            meetingDate: meta.date,
            chunkIndex: chunkStart + idx,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
          },
        }));

        await addDocuments(documents);
        totalChunks += documents.length;
      }

      meetingsProcessed++;

      if ((i + 1) % 10 === 0 || i === toIndex.length - 1) {
        console.error(`Indexed ${i + 1}/${toIndex.length} local meetings (${totalChunks} chunks)`);
      }
    } catch (error) {
      console.error(`Error processing local file ${meta.filePath}:`, error);
      meetingsSkipped++;
    }
  }

  return {
    meetingsProcessed,
    meetingsSkipped,
    meetingsAlreadyIndexed: alreadyIndexedCount,
    chunksCreated: totalChunks,
    durationMs: Date.now() - startTime,
  };
}

export interface IndexWisprResult {
  meetingsProcessed: number;
  meetingsSkipped: number;
  meetingsAlreadyIndexed: number;
  chunksCreated: number;
  transcriptsExported: number;
  exportPath?: string;
  durationMs: number;
}

const WISPR_EXPORT_PATH = `${process.env.HOME}/Documents/wispr-transcripts`;

/**
 * Index Wispr Flow meeting transcripts (speaker-attributed). Incremental by
 * meeting id. Also exports each new transcript to markdown so Recall keeps a
 * durable copy even if Wispr prunes its local data.
 */
export async function indexWisprTranscripts(): Promise<IndexWisprResult> {
  const startTime = Date.now();

  if (!(await wisprAvailable())) {
    console.error('Wispr Flow not found - skipping');
    return {
      meetingsProcessed: 0,
      meetingsSkipped: 0,
      meetingsAlreadyIndexed: 0,
      chunksCreated: 0,
      transcriptsExported: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const meetings = await listWisprMeetings();
  console.error(`Found ${meetings.length} Wispr meetings`);

  const indexedIds = await getIndexedMeetingIds('wispr-transcript');
  const toIndex = meetings.filter((m) => !indexedIds.has(m.id));
  const alreadyIndexedCount = meetings.length - toIndex.length;

  console.error(`To index: ${toIndex.length} (${alreadyIndexedCount} already indexed)`);

  let meetingsProcessed = 0;
  let meetingsSkipped = 0;
  let totalChunks = 0;
  const embeddingBatchSize = 20;
  const fetchedTranscripts: GranolaTranscript[] = [];

  for (const meeting of toIndex) {
    try {
      const transcript = await getWisprTranscript(meeting);

      if (!transcript || !transcript.content.trim()) {
        console.error(`Skipping Wispr meeting "${meeting.title}" (${meeting.id}): no transcript text`);
        meetingsSkipped++;
        continue;
      }

      const chunks = chunkText(transcript.content);

      for (let chunkStart = 0; chunkStart < chunks.length; chunkStart += embeddingBatchSize) {
        const chunkBatch = chunks.slice(chunkStart, chunkStart + embeddingBatchSize);
        const embeddings = await getEmbeddings(chunkBatch.map((c) => c.text));

        const documents: DocumentChunk[] = chunkBatch.map((chunk, idx) => ({
          id: `wispr:${transcript.meetingId}:${chunkStart + idx}`,
          text: chunk.text,
          embedding: embeddings[idx],
          metadata: {
            sourceType: 'wispr-transcript' as const,
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
      console.error(`Indexed "${transcript.meetingTitle}" (${transcript.meetingDate}, ${totalChunks} chunks total)`);
    } catch (error) {
      console.error(`Error processing Wispr meeting ${meeting.id}:`, error);
      meetingsSkipped++;
    }
  }

  let transcriptsExported = 0;
  if (fetchedTranscripts.length > 0) {
    const exportResult = await exportTranscripts(fetchedTranscripts, {
      exportPath: WISPR_EXPORT_PATH,
    });
    transcriptsExported = exportResult.exported;
    console.error(`Exported ${exportResult.exported} transcripts to ${exportResult.exportPath}`);
  }

  return {
    meetingsProcessed,
    meetingsSkipped,
    meetingsAlreadyIndexed: alreadyIndexedCount,
    chunksCreated: totalChunks,
    transcriptsExported,
    exportPath: fetchedTranscripts.length > 0 ? WISPR_EXPORT_PATH : undefined,
    durationMs: Date.now() - startTime,
  };
}
