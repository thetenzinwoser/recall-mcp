/**
 * Local transcript reader - reads from ~/Documents/granola-transcripts/
 * Used as fallback when Granola API is unavailable, and as source for
 * indexing manually-exported transcripts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { GranolaMeeting, GranolaTranscript } from './granola-api.js';

export const LOCAL_TRANSCRIPTS_PATH = path.join(
  process.env.HOME || '~',
  'Documents/granola-transcripts'
);

interface LocalTranscriptMeta {
  filePath: string;
  meetingId: string;
  title: string;
  date: string;
  segments: number;
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^"(.*)"$/, '$1');
    meta[key] = value;
  }

  return { meta, body: match[2] };
}

async function scanLocalFiles(): Promise<LocalTranscriptMeta[]> {
  let files: string[];
  try {
    files = await fs.readdir(LOCAL_TRANSCRIPTS_PATH);
  } catch {
    return [];
  }

  const results: LocalTranscriptMeta[] = [];

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(LOCAL_TRANSCRIPTS_PATH, file);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const { meta } = parseFrontmatter(content);
      if (!meta.meeting_id) continue;
      results.push({
        filePath,
        meetingId: meta.meeting_id,
        title: meta.title || file.replace(/\.md$/, ''),
        date: meta.date || '',
        segments: parseInt(meta.segments || '0', 10),
      });
    } catch {
      // skip unreadable files
    }
  }

  return results;
}

export async function listLocalMeetings(): Promise<GranolaMeeting[]> {
  const files = await scanLocalFiles();
  return files.map((f) => ({
    id: f.meetingId,
    title: f.title,
    createdAt: f.date ? `${f.date}T00:00:00.000Z` : '',
    updatedAt: f.date ? `${f.date}T00:00:00.000Z` : '',
  }));
}

export async function getLocalTranscript(
  meetingId: string
): Promise<GranolaTranscript | null> {
  const files = await scanLocalFiles();
  const match = files.find((f) => f.meetingId === meetingId);
  if (!match) return null;

  const content = await fs.readFile(match.filePath, 'utf-8');
  const { body } = parseFrontmatter(content);

  return {
    meetingId: match.meetingId,
    meetingTitle: match.title,
    meetingDate: match.date,
    content: body.trim(),
    segmentCount: match.segments,
  };
}

export async function getLocalTranscriptMetas(): Promise<LocalTranscriptMeta[]> {
  return scanLocalFiles();
}
