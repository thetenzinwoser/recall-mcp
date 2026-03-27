import { z } from 'zod';
import {
  listMeetings,
  getTranscript,
  GranolaMeeting,
} from '../services/granola-api.js';

export const getTranscriptInputSchema = z.object({
  meetingId: z.string().optional(),
  searchTitle: z.string().optional(),
  date: z.string().optional(),
  listRecent: z.coerce.number().min(1).max(50).optional(),
});

export type GetTranscriptInput = z.infer<typeof getTranscriptInputSchema>;

/**
 * Extract date-like patterns from a search string
 * Handles: "2026-03-02", "March 2", "March 02", "Mar 2", "3/2", etc.
 */
function extractDateFromSearch(search: string): { cleanedSearch: string; dateStr: string | null } {
  // ISO date: 2026-03-02
  const isoMatch = search.match(/(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) {
    return {
      cleanedSearch: search.replace(isoMatch[0], '').trim(),
      dateStr: isoMatch[1],
    };
  }

  // Month name + day: "March 2", "Mar 02", "March 10"
  const monthNames: Record<string, string> = {
    'jan': '01', 'january': '01',
    'feb': '02', 'february': '02',
    'mar': '03', 'march': '03',
    'apr': '04', 'april': '04',
    'may': '05',
    'jun': '06', 'june': '06',
    'jul': '07', 'july': '07',
    'aug': '08', 'august': '08',
    'sep': '09', 'september': '09',
    'oct': '10', 'october': '10',
    'nov': '11', 'november': '11',
    'dec': '12', 'december': '12',
  };

  const monthPattern = new RegExp(
    `(${Object.keys(monthNames).join('|')})\\s*(\\d{1,2})`,
    'i'
  );
  const monthMatch = search.match(monthPattern);
  if (monthMatch) {
    const month = monthNames[monthMatch[1].toLowerCase()];
    const day = monthMatch[2].padStart(2, '0');
    const dateStr = `${new Date().getFullYear()}-${month}-${day}`;
    return {
      cleanedSearch: search.replace(monthMatch[0], '').trim(),
      dateStr,
    };
  }

  return { cleanedSearch: search, dateStr: null };
}

function fuzzyMatch(title: string, search: string): number {
  const titleLower = title.toLowerCase();
  const searchLower = search.toLowerCase();

  if (titleLower === searchLower) return 1.0;
  if (titleLower.includes(searchLower)) return 0.9;

  const searchWords = searchLower.split(/\s+/).filter((w) => w.length > 2);
  const matchedWords = searchWords.filter((word) => titleLower.includes(word));

  if (searchWords.length === 0) return 0;
  return (matchedWords.length / searchWords.length) * 0.8;
}

async function findMeetings(
  search: string,
  meetings: GranolaMeeting[],
  dateFilter?: string
): Promise<GranolaMeeting[]> {
  // Extract date from search string if not provided separately
  let targetDate = dateFilter || null;
  let cleanSearch = search;

  if (!targetDate) {
    const extracted = extractDateFromSearch(search);
    targetDate = extracted.dateStr;
    cleanSearch = extracted.cleanedSearch;
  }

  // If we have a date filter, narrow the candidate set first
  let candidates = meetings;
  if (targetDate) {
    const dateMatches = meetings.filter((m) =>
      m.createdAt.startsWith(targetDate!)
    );
    if (dateMatches.length > 0) {
      candidates = dateMatches;
    }
    // If no date matches found, fall through to title-only matching
  }

  // If search is empty after extracting date (e.g., just "March 2"),
  // return all candidates from that date
  if (!cleanSearch || cleanSearch.length < 2) {
    return candidates;
  }

  const scored = candidates
    .map((meeting) => ({
      meeting,
      score: fuzzyMatch(meeting.title, cleanSearch),
    }))
    .filter((item) => item.score > 0.3)
    .sort((a, b) => b.score - a.score);

  return scored.map((item) => item.meeting);
}

export async function getTranscriptHandler(args: unknown): Promise<string> {
  const input = getTranscriptInputSchema.parse(args);

  if (!input.meetingId && !input.searchTitle && !input.listRecent) {
    return `**get_transcript** - Fetch full meeting transcripts from Granola

**Usage:**
- \`meetingId\`: Fetch transcript by exact meeting ID
- \`searchTitle\`: Search meetings by title and return best match's transcript
- \`listRecent\`: List N most recent meetings (to find IDs)

**Examples:**
- Get specific transcript: \`{ "meetingId": "9b836e80-4fd0-4b5d-a634-62861e44495a" }\`
- Search by title: \`{ "searchTitle": "design review" }\`
- List recent meetings: \`{ "listRecent": 10 }\``;
  }

  if (input.listRecent) {
    const meetings = await listMeetings(input.listRecent);

    let response = `**${meetings.length} Most Recent Meetings:**\n\n`;
    response += '| Date | Title | ID |\n';
    response += '|------|-------|----|\n';

    for (const meeting of meetings) {
      const date = meeting.createdAt.split('T')[0];
      const shortId = meeting.id.slice(0, 8) + '...';
      response += `| ${date} | ${meeting.title} | \`${shortId}\` |\n`;
    }

    response += `\n*Use the full meeting ID with \`meetingId\` parameter to fetch transcript.*`;
    return response;
  }

  if (input.searchTitle) {
    const meetings = await listMeetings(500);
    const matches = await findMeetings(input.searchTitle, meetings, input.date);

    if (matches.length === 0) {
      return `No meetings found matching "${input.searchTitle}"`;
    }

    const bestMatch = matches[0];

    let response = '';
    if (matches.length > 1) {
      response += `**Found ${matches.length} matches for "${input.searchTitle}":**\n`;
      matches.slice(0, 5).forEach((m, i) => {
        const date = m.createdAt.split('T')[0];
        const marker = i === 0 ? ' <- fetching this one' : '';
        response += `${i + 1}. ${m.title} (${date})${marker}\n`;
      });
      response += '\n---\n\n';
    }

    const transcript = await getTranscript(
      bestMatch.id,
      bestMatch.title,
      bestMatch.createdAt.split('T')[0]
    );

    if (!transcript) {
      response += `**${bestMatch.title}** (${bestMatch.createdAt.split('T')[0]})\n\n`;
      response += `*No transcript available for this meeting.*\n`;
      response += `Meeting ID: \`${bestMatch.id}\``;
      return response;
    }

    response += `# ${transcript.meetingTitle}\n`;
    response += `**Date:** ${transcript.meetingDate}\n`;
    response += `**Meeting ID:** \`${transcript.meetingId}\`\n`;
    response += `**Segments:** ${transcript.segmentCount}\n\n`;
    response += `---\n\n`;
    response += transcript.content;

    return response;
  }

  if (input.meetingId) {
    const meetings = await listMeetings(1000);
    // Support both full and partial ID matching
    const meeting = meetings.find((m) =>
      m.id === input.meetingId || m.id.startsWith(input.meetingId!)
    );

    const title = meeting?.title || 'Unknown Meeting';
    const date = meeting?.createdAt.split('T')[0] || '';

    const resolvedId = meeting?.id || input.meetingId!;
    const transcript = await getTranscript(resolvedId, title, date);

    if (!transcript) {
      return `**${title}** (${date})\n\n*No transcript available for meeting ID \`${input.meetingId}\`*`;
    }

    let response = `# ${transcript.meetingTitle}\n`;
    response += `**Date:** ${transcript.meetingDate}\n`;
    response += `**Meeting ID:** \`${transcript.meetingId}\`\n`;
    response += `**Segments:** ${transcript.segmentCount}\n\n`;
    response += `---\n\n`;
    response += transcript.content;

    return response;
  }

  return 'Please provide meetingId, searchTitle, or listRecent parameter.';
}

export const getTranscriptTool = {
  name: 'get_transcript',
  description:
    'Fetch the full transcript of a Granola meeting. Supports search by title + date (e.g., "JT 1:1" + "2026-03-02"), partial meeting IDs, and listing recent meetings. Date can be embedded in searchTitle (e.g., "JT March 2") or passed separately.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      meetingId: {
        type: 'string',
        description: 'Granola meeting ID - supports both full UUID and partial prefix (e.g., "3453175f")',
      },
      searchTitle: {
        type: 'string',
        description:
          'Search for meeting by title (fuzzy match). Dates in the query are extracted automatically (e.g., "JT March 2" finds JT meetings on March 2). Returns transcript of best match.',
      },
      date: {
        type: 'string',
        description:
          'Filter by date (YYYY-MM-DD format). Use with searchTitle to disambiguate meetings with identical titles on different dates.',
      },
      listRecent: {
        type: 'number',
        description:
          'List N most recent meetings with their IDs (1-50). Use this to find meeting IDs.',
      },
    },
  },
  handler: getTranscriptHandler,
};
