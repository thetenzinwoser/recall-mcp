/**
 * Granola API - uses the internal app API (api.granola.ai) with WorkOS auth.
 * Auth tokens are read from the encrypted local store, using the same key
 * derivation as the Granola desktop app. Falls back to local transcript
 * files when auth is unavailable.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { listLocalMeetings, getLocalTranscript } from './local-transcripts.js';

const INTERNAL_API_URL = 'https://api.granola.ai/v1';
const USER_DATA_DIR = path.join(process.env.HOME || '~', 'Library/Application Support/Granola');

// As of a mid-July 2026 Granola update, the app migrated its data-encryption key
// (DEK) out of the `storage.dek` file and into the macOS data-protection keychain
// under access group `QZ7DHHLN25.granola`. That item is only readable by Granola's
// own code-signed binary, so an unsigned process (this indexer) can no longer
// decrypt Granola's local store. Instead we keep our OWN WorkOS refresh-token
// lineage: seed it once from Granola's legacy plaintext token files, persist it in
// Recall's data dir, then self-refresh. WorkOS returns the same (non-rotating)
// refresh token, so this does not conflict with Granola's own session.
const TOKENS_CACHE_PATH = path.join(process.env.HOME || '~', 'recall-mcp/data/granola-tokens.json');
// Legacy plaintext token files written by older Granola builds (pre-encryption).
// Used only to seed the lineage on first run.
const SEED_PATHS = [
  path.join(USER_DATA_DIR, 'supabase.json'),
  path.join(USER_DATA_DIR, 'stored-accounts.json'),
];

const gunzip = promisify(zlib.gunzip);

// ─── Auth token management ───────────────────────────────────────────────────

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  obtained_at: number;
  session_id: string;
}

let _cachedTokens: StoredTokens | null = null;
let _authUnavailable = false;

function persistTokens(tokens: StoredTokens): void {
  try {
    fs.mkdirSync(path.dirname(TOKENS_CACHE_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_CACHE_PATH, JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error('Could not persist Granola tokens:', err);
  }
}

function seedTokensFromGranola(): StoredTokens | null {
  for (const p of SEED_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
      let tok: { access_token?: string; refresh_token?: string; session_id?: string } | null = null;
      if (raw.workos_tokens) {
        // supabase.json: { workos_tokens: "<json string>" }
        tok = JSON.parse(raw.workos_tokens);
      } else if (raw.accounts) {
        // stored-accounts.json: { accounts: [ { tokens: "<json string>" } ] }
        const accounts = typeof raw.accounts === 'string' ? JSON.parse(raw.accounts) : raw.accounts;
        if (accounts?.[0]?.tokens) tok = JSON.parse(accounts[0].tokens);
      }
      if (tok?.refresh_token) {
        // expires_in/obtained_at zeroed so the first call forces a refresh
        // (the seed access_token may be stale; the refresh_token is what matters).
        return {
          access_token: tok.access_token || '',
          refresh_token: tok.refresh_token,
          expires_in: 0,
          obtained_at: 0,
          session_id: tok.session_id || '',
        };
      }
    } catch (err) {
      console.error(`Could not seed Granola tokens from ${p}:`, err);
    }
  }
  return null;
}

function loadStoredTokens(): StoredTokens | null {
  // Prefer Recall's own persisted token lineage.
  try {
    if (fs.existsSync(TOKENS_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_CACHE_PATH, 'utf-8')) as StoredTokens;
    }
  } catch (err) {
    console.error('Could not read Recall token cache, will re-seed:', err);
  }
  // First run (or corrupt cache): seed from Granola's plaintext token files.
  const seeded = seedTokensFromGranola();
  if (seeded) persistTokens(seeded);
  else console.error('Could not load or seed Granola auth tokens (no readable token source)');
  return seeded;
}

function isTokenExpired(tokens: StoredTokens): boolean {
  // obtained_at is in ms, expires_in is in seconds, subtract 60s buffer
  const expiresAt = tokens.obtained_at + (tokens.expires_in - 60) * 1000;
  return Date.now() > expiresAt;
}

async function refreshAccessToken(tokens: StoredTokens): Promise<StoredTokens | null> {
  try {
    const response = await fetch(`${INTERNAL_API_URL}/refresh-access-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: tokens.refresh_token }),
    });
    if (!response.ok) return null;
    const data = await response.json() as StoredTokens;
    // Normalize obtained_at to local ms epoch so expiry math is reliable, and
    // preserve the prior refresh_token if the response omits one. Persist so the
    // lineage survives even if Granola's legacy plaintext seed files disappear.
    const refreshed: StoredTokens = {
      ...data,
      refresh_token: data.refresh_token || tokens.refresh_token,
      obtained_at: Date.now(),
    };
    persistTokens(refreshed);
    return refreshed;
  } catch {
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (_authUnavailable) return null;

  // Load from disk if not cached
  if (!_cachedTokens) {
    _cachedTokens = loadStoredTokens();
    if (!_cachedTokens) {
      _authUnavailable = true;
      return null;
    }
  }

  // Refresh if expired
  if (isTokenExpired(_cachedTokens)) {
    const refreshed = await refreshAccessToken(_cachedTokens);
    if (!refreshed) {
      _authUnavailable = true;
      return null;
    }
    _cachedTokens = refreshed;
  }

  return _cachedTokens.access_token;
}

// ─── Internal API helpers ─────────────────────────────────────────────────────

async function internalPost<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error('Granola auth unavailable');

  const response = await fetch(`${INTERNAL_API_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Granola internal API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

// ─── Public interfaces ────────────────────────────────────────────────────────

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

export interface GetTranscriptsOptions {
  meetingIds?: string[];
  limit?: number;
  onProgress?: (processed: number, total: number, title: string) => void;
}

// ─── API functions ────────────────────────────────────────────────────────────

interface DocumentResponse {
  id: string;
  title?: string | null;
  created_at: string;
  updated_at: string;
}

export async function listMeetings(
  limit: number = 1000,
  _offset: number = 0
): Promise<GranolaMeeting[]> {
  const token = await getAccessToken();
  if (!token) {
    console.error('Granola auth unavailable - falling back to local transcripts');
    return listLocalMeetings();
  }

  try {
    const docs = await internalPost<DocumentResponse[]>('/get-documents', { limit });
    return docs.map((d) => ({
      id: d.id,
      title: d.title || 'Untitled',
      createdAt: d.created_at,
      updatedAt: d.updated_at,
    }));
  } catch (err) {
    console.error('listMeetings failed, falling back to local:', err);
    return listLocalMeetings();
  }
}

interface TranscriptChunk {
  document_id: string;
  text: string;
  source: string;
  start_timestamp: string;
  end_timestamp: string;
  is_final: boolean;
  id: string;
  detected_speaker_name: string | null;
}

export async function getTranscript(
  meetingId: string,
  meetingTitle: string = 'Untitled',
  meetingDate: string = ''
): Promise<GranolaTranscript | null> {
  const token = await getAccessToken();
  if (!token) {
    return getLocalTranscript(meetingId);
  }

  try {
    const response = await fetch(`${INTERNAL_API_URL}/get-document-transcript`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip',
      },
      body: JSON.stringify({ document_id: meetingId }),
    });

    if (!response.ok) {
      return getLocalTranscript(meetingId);
    }

    // Response is gzip-compressed JSON array of transcript chunks
    const buffer = Buffer.from(await response.arrayBuffer());
    let jsonBytes: Buffer;
    try {
      jsonBytes = await gunzip(buffer);
    } catch {
      jsonBytes = buffer; // already decompressed
    }

    const chunks: TranscriptChunk[] = JSON.parse(jsonBytes.toString('utf-8'));
    if (!chunks || chunks.length === 0) {
      return getLocalTranscript(meetingId);
    }

    // Sort by start_timestamp and join text
    const sorted = chunks
      .filter((c) => c.is_final && c.text?.trim())
      .sort((a, b) => a.start_timestamp.localeCompare(b.start_timestamp));

    const content = sorted.map((c) => c.text).join(' ');

    return {
      meetingId,
      meetingTitle,
      meetingDate,
      content,
      segmentCount: sorted.length,
    };
  } catch (err) {
    console.error(`Failed to get transcript for meeting ${meetingId}:`, err);
    return getLocalTranscript(meetingId);
  }
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
    if (onProgress) onProgress(i + 1, total, meeting.title);

    const transcript = await getTranscript(
      meeting.id,
      meeting.title,
      meeting.createdAt.split('T')[0]
    );

    if (transcript) transcripts.push(transcript);

    if (i < meetings.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return transcripts;
}

export async function getAuthToken(): Promise<string> {
  return (await getAccessToken()) ?? '';
}
