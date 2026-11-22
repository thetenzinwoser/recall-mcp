/**
 * Wispr Flow transcript reader - reads meeting transcripts from Wispr Flow's
 * local data (flow.sqlite + per-meeting ndjson files). Unlike Granola, Wispr
 * transcripts are speaker-diarized with real names, resolved via the
 * speakerMap stored on each Meetings row.
 *
 * flow.sqlite is queried read-only via the system sqlite3 CLI so we don't
 * need a native sqlite dependency and can't interfere with the running app.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WISPR_DATA_DIR = path.join(
  process.env.HOME || '~',
  'Library/Application Support/Wispr Flow'
);
const WISPR_DB_PATH = path.join(WISPR_DATA_DIR, 'flow.sqlite');
const WISPR_MEETINGS_DIR = path.join(WISPR_DATA_DIR, 'meetings');

export interface WisprMeeting {
  id: string;
  title: string;
  createdAt: string; // ISO datetime
  startEpochMs: number;
  speakerMap: SpeakerMap | null;
}

export interface WisprTranscript {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string; // YYYY-MM-DD
  content: string;
  segmentCount: number;
}

interface SpeakerMap {
  people?: Record<string, { name?: string }>;
  assignments?: Record<
    string,
    { user?: string | null; consensus?: string | null; mic?: string | null; llm?: string | null; dom?: string | null }
  >;
}

async function queryDb(sql: string): Promise<Record<string, unknown>[]> {
  const opts = { maxBuffer: 64 * 1024 * 1024 };
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', WISPR_DB_PATH, sql], opts));
  } catch (error) {
    // A plain read-only open can fail with SQLITE_CANTOPEN (14) even though the
    // file is readable (seen Nov 2026 after Wispr quit). immutable=1 skips the
    // locking/journal checks. Only used as a fallback, since immutable reads can
    // see a torn state if Wispr is writing at that moment.
    const uri = `file:${encodeURI(WISPR_DB_PATH)}?mode=ro&immutable=1`;
    console.warn('Wispr DB read-only open failed, retrying with immutable=1');
    ({ stdout } = await execFileAsync('sqlite3', ['-json', uri, sql], opts));
  }
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

/**
 * Convert Wispr's sqlite datetime ("2026-08-04 15:00:48.810 +00:00") to ISO.
 */
function toIso(sqliteDate: string): string {
  const parsed = new Date(sqliteDate);
  return isNaN(parsed.getTime()) ? sqliteDate : parsed.toISOString();
}

export async function wisprAvailable(): Promise<boolean> {
  try {
    await fs.access(WISPR_DB_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * List real, finished Wispr meetings. Excludes deleted meetings, tour demos,
 * and meetings imported from Granola (those are already indexed as Granola).
 */
export async function listWisprMeetings(): Promise<WisprMeeting[]> {
  if (!(await wisprAvailable())) return [];

  const rows = await queryDb(
    `SELECT id, title, createdAt, speakerMap FROM Meetings
     WHERE isDeleted = 0 AND isTourDemo = 0 AND finalized = 1
       AND (importSource IS NULL OR importSource = '')
     ORDER BY createdAt DESC;`
  );

  return rows.map((row) => {
    let speakerMap: SpeakerMap | null = null;
    try {
      if (row.speakerMap) speakerMap = JSON.parse(row.speakerMap as string);
    } catch {
      // unparseable speakerMap - fall back to numbered speakers
    }
    const iso = toIso(row.createdAt as string);
    return {
      id: row.id as string,
      title: (row.title as string) || 'Untitled',
      createdAt: iso,
      startEpochMs: new Date(iso).getTime(),
      speakerMap,
    };
  });
}

function resolveSpeakerNames(speakerMap: SpeakerMap | null): Map<number, string> {
  const names = new Map<number, string>();
  if (!speakerMap?.assignments) return names;

  const people = speakerMap.people || {};
  for (const [speakerId, assignment] of Object.entries(speakerMap.assignments)) {
    // user = manual correction, consensus = reconciled mic/dom/llm signals
    const personId =
      assignment.user || assignment.consensus || assignment.mic || assignment.llm || assignment.dom;
    const name = personId ? people[personId]?.name : undefined;
    if (name) names.set(parseInt(speakerId, 10), name);
  }
  return names;
}

interface TranscriptLine {
  text?: string;
  speaker?: { id?: number };
}

/**
 * Build a speaker-attributed transcript from a meeting's ndjson files.
 * Prefers refined.ndjson (diarized, cleaned); falls back to live.ndjson.
 * Consecutive utterances from the same speaker are merged into one paragraph.
 */
export async function getWisprTranscript(meeting: WisprMeeting): Promise<WisprTranscript | null> {
  const meetingDir = path.join(WISPR_MEETINGS_DIR, meeting.id);
  let raw: string | null = null;

  for (const file of ['refined.ndjson', 'live.ndjson']) {
    try {
      raw = await fs.readFile(path.join(meetingDir, file), 'utf-8');
      if (raw.trim()) break;
    } catch {
      raw = null;
    }
  }
  if (!raw || !raw.trim()) return null;

  const speakerNames = resolveSpeakerNames(meeting.speakerMap);
  const paragraphs: string[] = [];
  let currentSpeaker: string | null = null;
  let currentTexts: string[] = [];
  let segmentCount = 0;

  const flush = () => {
    if (currentTexts.length === 0) return;
    const body = currentTexts.join(' ').replace(/\s+/g, ' ').trim();
    paragraphs.push(currentSpeaker ? `${currentSpeaker}: ${body}` : body);
    currentTexts = [];
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const text = entry.text?.trim();
    if (!text) continue; // skips meta lines too

    segmentCount++;
    const speakerId = entry.speaker?.id;
    const speaker =
      speakerId != null ? speakerNames.get(speakerId) || `Speaker ${speakerId}` : null;

    if (speaker !== currentSpeaker) {
      flush();
      currentSpeaker = speaker;
    }
    currentTexts.push(text);
  }
  flush();

  if (paragraphs.length === 0) return null;

  return {
    meetingId: meeting.id,
    meetingTitle: meeting.title,
    meetingDate: meeting.createdAt.split('T')[0],
    content: paragraphs.join('\n\n'),
    segmentCount,
  };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Both apps start recording within ~a minute of each other for the same
// meeting. Keep this tight - a wide window falsely matches back-to-back
// meetings that only one app recorded.
const OVERLAP_WINDOW_MS = 10 * 60 * 1000;

/**
 * Dedup guard: does a Wispr meeting cover the same meeting as this
 * Granola-side record? Wispr wins whenever both recorded the same meeting.
 *
 * Matches on start-time proximity when the Granola record has a real time,
 * or same calendar date + same normalized title when it only has a date
 * (local markdown exports carry date-only timestamps).
 */
export function isCoveredByWispr(
  granolaMeeting: { title: string; createdAt: string },
  wisprMeetings: WisprMeeting[]
): boolean {
  if (wisprMeetings.length === 0) return false;

  const granolaTime = new Date(granolaMeeting.createdAt).getTime();
  const granolaDate = granolaMeeting.createdAt.split('T')[0];
  const hasRealTime = !isNaN(granolaTime) && !granolaMeeting.createdAt.includes('T00:00:00');
  const granolaTitle = normalizeTitle(granolaMeeting.title);

  return wisprMeetings.some((w) => {
    if (hasRealTime && Math.abs(w.startEpochMs - granolaTime) <= OVERLAP_WINDOW_MS) {
      return true;
    }
    return (
      granolaTitle.length > 0 &&
      w.createdAt.split('T')[0] === granolaDate &&
      normalizeTitle(w.title) === granolaTitle
    );
  });
}
