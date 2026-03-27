import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const GRANOLA_API_URL = 'https://api.granola.ai';
const GRANOLA_AUTH_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Granola/supabase.json'
);

export interface GranolaMeeting {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface GranolaTranscript {
  meetingId: string;
  meetingTitle: string;
  meetingDate: string;
  content: string;
  segmentCount: number;
}

interface TranscriptSegment {
  id: string;
  text: string;
  start_timestamp: number;
  end_timestamp: number;
  source: string;
  confidence?: number;
}

interface GranolaAuthTokens {
  access_token: string;
  refresh_token: string;
  obtained_at: number;
  expires_in: number;
}

export async function getAuthToken(): Promise<string> {
  try {
    const authData = await fs.readFile(GRANOLA_AUTH_PATH, 'utf-8');
    const parsed = JSON.parse(authData);

    const workosTokens: GranolaAuthTokens = JSON.parse(parsed.workos_tokens);

    return workosTokens.access_token;
  } catch (error) {
    throw new Error(
      `Failed to load Granola auth token from ${GRANOLA_AUTH_PATH}: ${error}`
    );
  }
}

async function granolaFetch<T>(
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const token = await getAuthToken();

  const response = await fetch(`${GRANOLA_API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Granola/5.354.0',
      'X-Client-Version': '5.354.0',
      'Accept-Encoding': 'gzip, deflate',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Granola API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

export async function listMeetings(
  limit: number = 1000,
  offset: number = 0
): Promise<GranolaMeeting[]> {
  interface GetDocumentsResponse {
    docs: Array<{
      id: string;
      title: string;
      created_at: string;
      updated_at: string;
    }>;
  }

  const response = await granolaFetch<GetDocumentsResponse>(
    '/v2/get-documents',
    { limit, offset }
  );

  return response.docs.map((doc) => ({
    id: doc.id,
    title: doc.title || 'Untitled',
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  }));
}

export async function getTranscript(
  meetingId: string,
  meetingTitle: string = 'Untitled',
  meetingDate: string = ''
): Promise<GranolaTranscript | null> {
  try {
    const segments = await granolaFetch<TranscriptSegment[]>(
      '/v1/get-document-transcript',
      { document_id: meetingId }
    );

    if (!segments || segments.length === 0) {
      return null;
    }

    const sortedSegments = [...segments].sort(
      (a, b) => a.start_timestamp - b.start_timestamp
    );

    const content = sortedSegments.map((seg) => seg.text).join(' ');

    return {
      meetingId,
      meetingTitle,
      meetingDate,
      content,
      segmentCount: segments.length,
    };
  } catch (error) {
    console.error(`Failed to get transcript for meeting ${meetingId}:`, error);
    return null;
  }
}

export interface GetTranscriptsOptions {
  meetingIds?: string[];
  limit?: number;
  onProgress?: (processed: number, total: number, title: string) => void;
}

export async function getTranscripts(
  options: GetTranscriptsOptions = {}
): Promise<GranolaTranscript[]> {
  const { meetingIds, limit, onProgress } = options;

  let meetings = await listMeetings();

  if (meetingIds && meetingIds.length > 0) {
    const idSet = new Set(meetingIds);
    meetings = meetings.filter((m) => idSet.has(m.id));
  }

  if (limit && limit > 0) {
    meetings = meetings.slice(0, limit);
  }

  const transcripts: GranolaTranscript[] = [];
  const total = meetings.length;

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];

    if (onProgress) {
      onProgress(i + 1, total, meeting.title);
    }

    const transcript = await getTranscript(
      meeting.id,
      meeting.title,
      meeting.createdAt.split('T')[0]
    );

    if (transcript) {
      transcripts.push(transcript);
    }

    if (i < meetings.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return transcripts;
}
