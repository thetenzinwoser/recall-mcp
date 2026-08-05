/**
 * Claude Code session indexer - indexes the dialogue (user + assistant text)
 * from ~/.claude/projects/<project>/<session>.jsonl files. Tool calls, tool
 * results, thinking blocks, and subagent sidechains are all dropped: they're
 * mostly file dumps already indexed as strategy docs, and they'd bury the
 * actual conversation in noise.
 *
 * Incremental by file mtime. Sessions still being written (mtime < 1h old)
 * are skipped until they go quiet, so active sessions aren't re-embedded
 * every cycle.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { chunkText } from '../utils/chunker.js';
import { getEmbeddings } from './embeddings.js';
import {
  addDocuments,
  deleteByMeetingIds,
  getCollection,
  DocumentChunk,
} from './vectordb.js';
import { IncludeEnum } from 'chromadb';

const PROJECTS_DIR = path.join(process.env.HOME || '~', '.claude/projects');
const MIN_DIALOGUE_CHARS = 500;
const ACTIVE_SESSION_QUIET_MS = 60 * 60 * 1000;

interface SessionMeta {
  filePath: string;
  sessionId: string;
  project: string;
  mtimeMs: number;
}

interface ExtractedSession {
  sessionId: string;
  title: string;
  date: string; // YYYY-MM-DD of first message
  dialogue: string;
}

async function listSessionFiles(): Promise<SessionMeta[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];
  for (const dir of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    // Human-readable project name from the slug, e.g.
    // "-Users-tenzin-Strategy-projects-apollo" -> "Strategy/projects/apollo"
    const project = dir.replace(/^-Users-[^-]+-/, '').replace(/-/g, '/');

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, file);
      try {
        const stat = await fs.stat(filePath);
        sessions.push({
          filePath,
          sessionId: file.replace(/\.jsonl$/, ''),
          project,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // unreadable - skip
      }
    }
  }
  return sessions;
}

/** Strip harness-injected noise from a user message. */
function cleanUserText(text: string): string {
  let cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  // Slash-command invocations wrap the real prompt in command tags
  cleaned = cleaned.replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/g, ' ');
  cleaned = cleaned.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  return cleaned.trim();
}

function isNoiseUserMessage(text: string): boolean {
  return (
    text.length === 0 ||
    text.startsWith('[SYSTEM NOTIFICATION') ||
    text.startsWith('<task-notification>') ||
    text.startsWith('Caveat:') ||
    /^\[Request interrupted/.test(text)
  );
}

export function extractDialogue(raw: string, meta: SessionMeta): ExtractedSession | null {
  let title: string | null = null;
  let aiTitle: string | null = null;
  let firstTimestamp: string | null = null;
  let firstUserText: string | null = null;
  const parts: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type === 'custom-title' && obj.customTitle) title = obj.customTitle as string;
    if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = obj.aiTitle as string;

    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    if (obj.isSidechain) continue; // subagent traffic

    const message = obj.message as { content?: unknown } | undefined;
    if (!message) continue;

    if (!firstTimestamp && typeof obj.timestamp === 'string') {
      firstTimestamp = obj.timestamp;
    }

    if (obj.type === 'user') {
      // String content = actual typed prompt. List content = tool results - skip
      // everything except explicit text blocks.
      const texts: string[] = [];
      if (typeof message.content === 'string') {
        texts.push(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content as { type?: string; text?: string }[]) {
          if (block.type === 'text' && block.text) texts.push(block.text);
        }
      }
      for (const text of texts) {
        const cleaned = cleanUserText(text);
        if (isNoiseUserMessage(cleaned)) continue;
        if (!firstUserText) firstUserText = cleaned;
        parts.push(`User: ${cleaned}`);
      }
    } else {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as { type?: string; text?: string }[]) {
        if (block.type === 'text' && block.text?.trim()) {
          parts.push(`Claude: ${block.text.trim()}`);
        }
      }
    }
  }

  const dialogue = parts.join('\n\n');
  if (dialogue.length < MIN_DIALOGUE_CHARS) return null;

  const fallbackTitle = firstUserText
    ? firstUserText.slice(0, 60).replace(/\s+/g, ' ')
    : 'Untitled session';

  return {
    sessionId: meta.sessionId,
    title: `[${meta.project}] ${title || aiTitle || fallbackTitle}`,
    date: firstTimestamp ? firstTimestamp.split('T')[0] : '',
    dialogue,
  };
}

/** sessionId -> indexed fileMtime, for incremental updates. */
async function getIndexedSessions(): Promise<Map<string, number>> {
  const coll = await getCollection();
  const results = await coll.get({
    where: { sourceType: 'claude-session' },
    include: [IncludeEnum.Metadatas],
  });

  const map = new Map<string, number>();
  for (const meta of results.metadatas || []) {
    const m = meta as Record<string, unknown>;
    const sessionId = m?.meetingId as string;
    const mtime = m?.fileMtime as number;
    if (sessionId && !map.has(sessionId)) map.set(sessionId, mtime || 0);
  }
  return map;
}

export interface IndexSessionsResult {
  sessionsProcessed: number;
  sessionsUpdated: number;
  sessionsSkipped: number;
  sessionsAlreadyIndexed: number;
  chunksCreated: number;
  durationMs: number;
}

export async function indexClaudeSessions(): Promise<IndexSessionsResult> {
  const startTime = Date.now();
  const now = Date.now();

  const allSessions = await listSessionFiles();
  console.error(`Found ${allSessions.length} Claude Code session files`);

  const quietSessions = allSessions.filter(
    (s) => now - s.mtimeMs > ACTIVE_SESSION_QUIET_MS
  );
  const activeCount = allSessions.length - quietSessions.length;
  if (activeCount > 0) {
    console.error(`Deferring ${activeCount} recently-active sessions`);
  }

  const indexed = await getIndexedSessions();
  const newSessions = quietSessions.filter((s) => !indexed.has(s.sessionId));
  const changedSessions = quietSessions.filter(
    (s) => indexed.has(s.sessionId) && Math.round(s.mtimeMs) > (indexed.get(s.sessionId) || 0)
  );
  const alreadyIndexedCount = quietSessions.length - newSessions.length - changedSessions.length;

  console.error(
    `To index: ${newSessions.length} new, ${changedSessions.length} updated (${alreadyIndexedCount} unchanged)`
  );

  // Changed sessions get their old chunks replaced wholesale
  if (changedSessions.length > 0) {
    await deleteByMeetingIds(changedSessions.map((s) => s.sessionId), 'claude-session');
  }

  let sessionsProcessed = 0;
  let sessionsSkipped = 0;
  let totalChunks = 0;
  const embeddingBatchSize = 20;
  const toProcess = [...newSessions, ...changedSessions];

  for (const session of toProcess) {
    try {
      const raw = await fs.readFile(session.filePath, 'utf-8');
      const extracted = extractDialogue(raw, session);

      if (!extracted) {
        sessionsSkipped++;
        continue;
      }

      const chunks = chunkText(extracted.dialogue);

      for (let chunkStart = 0; chunkStart < chunks.length; chunkStart += embeddingBatchSize) {
        const chunkBatch = chunks.slice(chunkStart, chunkStart + embeddingBatchSize);
        const embeddings = await getEmbeddings(chunkBatch.map((c) => c.text));

        const documents: DocumentChunk[] = chunkBatch.map((chunk, idx) => ({
          id: `session:${extracted.sessionId}:${chunkStart + idx}`,
          text: chunk.text,
          embedding: embeddings[idx],
          metadata: {
            sourceType: 'claude-session' as const,
            meetingId: extracted.sessionId,
            meetingTitle: extracted.title,
            meetingDate: extracted.date,
            filePath: session.filePath,
            fileMtime: Math.round(session.mtimeMs),
            chunkIndex: chunkStart + idx,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
          },
        }));

        await addDocuments(documents);
        totalChunks += documents.length;
      }

      sessionsProcessed++;
      if (sessionsProcessed % 20 === 0) {
        console.error(`Indexed ${sessionsProcessed}/${toProcess.length} sessions (${totalChunks} chunks)`);
      }
    } catch (error) {
      console.error(`Error processing session ${session.sessionId}:`, error);
      sessionsSkipped++;
    }
  }

  console.error(`Indexed ${sessionsProcessed} sessions, ${totalChunks} chunks`);

  return {
    sessionsProcessed,
    sessionsUpdated: changedSessions.length,
    sessionsSkipped,
    sessionsAlreadyIndexed: alreadyIndexedCount,
    chunksCreated: totalChunks,
    durationMs: Date.now() - startTime,
  };
}
