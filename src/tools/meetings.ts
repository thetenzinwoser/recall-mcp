import { z } from 'zod';
import { CONTEXTS, reloadTags, participantsOf } from '../services/classifier.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const listMeetingsSchema = z.object({
  context: z.enum(CONTEXTS).optional(),
  participant: z.string().min(1).optional(),
  afterDate: isoDate.optional(),
  beforeDate: isoDate.optional(),
  limit: z.number().min(1).max(500).optional().default(100),
});

/**
 * Deterministic listing of tagged Wispr meetings. Unlike semantic_search this
 * returns every match, so it is the right tool for "find all meetings where...".
 */
export async function listMeetings(args: unknown): Promise<string> {
  const input = listMeetingsSchema.parse(args);
  const tags = await reloadTags();
  const needle = input.participant?.toLowerCase();

  const rows = Object.entries(tags)
    .filter(([, t]) => !input.context || t.context === input.context || t.context2 === input.context)
    .filter(([, t]) => !input.afterDate || t.date >= input.afterDate)
    .filter(([, t]) => !input.beforeDate || t.date <= input.beforeDate)
    .filter(([, t]) => !needle || participantsOf(t).some((p) => p.toLowerCase().includes(needle)))
    .sort(([, a], [, b]) => b.date.localeCompare(a.date));

  if (rows.length === 0) {
    return `No tagged meetings match. (${Object.keys(tags).length} meetings tagged so far.)`;
  }

  const shown = rows.slice(0, input.limit);
  const lines = shown.map(([id, t]) => {
    const ctx = t.context + (t.context2 ? `+${t.context2}` : '');
    const inferred = Object.values(t.inferredSpeakers);
    const people = [
      ...t.namedSpeakers,
      ...inferred.filter((n) => !t.namedSpeakers.includes(n)).map((n) => `${n} (inferred)`),
    ];
    return [
      `- **${t.date}** [${ctx}] ${t.title}`,
      t.summary ? `  ${t.summary}` : '',
      people.length ? `  People: ${people.join(', ')}` : '',
      `  meeting_id: ${id}`,
    ]
      .filter(Boolean)
      .join('\n');
  });

  const more = rows.length > shown.length ? `\n\n(${rows.length - shown.length} more not shown; raise limit)` : '';
  return `${rows.length} meeting(s):\n\n${lines.join('\n')}${more}`;
}
