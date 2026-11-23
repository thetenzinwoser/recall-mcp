/**
 * Meeting classifier - tags each transcript with a life context (work / mable /
 * personal / other) and guesses names for unnamed speakers ("Speaker 2").
 *
 * Runs on a small local model through Ollama, so transcripts never leave the
 * machine. Each meeting is classified once; results are cached in
 * data/meeting-tags.json so re-indexing never re-runs inference.
 */

import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config/config.js';

export const CONTEXTS = ['work', 'mable', 'therapy', 'mentorship', 'personal', 'other'] as const;
export type Context = (typeof CONTEXTS)[number];

export const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'qwen2.5:7b';

const EXCERPT_CHARS = 7000;

// Life-area descriptions, names and rules live in data/classifier-config.json
// (gitignored, personal). The defaults below are deliberately generic.
interface ClassifierConfig {
  intro: string;
  areas: string;
  rules: { context: Context; speakerPattern?: string; summaryPattern?: string }[];
}

const DEFAULT_CONFIG: ClassifierConfig = {
  intro: 'You label meeting transcripts for the user. Their life has these areas:',
  areas: [
    '- "work": their day job: coworkers, product, design, planning, standups, reviews.',
    '- "mable": their side-project app and its cofounder.',
    '- "therapy": sessions with their therapist.',
    '- "mentorship": calls where they mentor someone.',
    '- "personal": the rest of their life: dating, friends, family, health, solo reflections.',
    '- "other": none of the above.',
  ].join('\n'),
  rules: [],
};

const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/classifier-config.json'
);

let classifierConfig: ClassifierConfig | null = null;

async function getClassifierConfig(): Promise<ClassifierConfig> {
  if (classifierConfig) return classifierConfig;
  try {
    classifierConfig = { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8')) };
  } catch {
    classifierConfig = DEFAULT_CONFIG;
  }
  return classifierConfig!;
}

const PROMPT_TAIL = `Meeting titles are auto-generated and often wrong. Judge by what is actually discussed, not the title.

Return JSON with:
- "summary": one plain sentence saying what the meeting is actually about and who is in it.
- "context": the main area.
- "secondary": a second area only if a large part of the meeting is clearly about it, otherwise null.
- "speakers": for unnamed speakers like "Speaker 2", the person's name ONLY when the transcript makes it clear (they introduce themselves, or someone addresses them by name and they answer). Each entry has "label" (e.g. "Speaker 2"), "name", and "evidence" (a short exact quote from the transcript that shows it). Return an empty list when unsure. Never guess.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    context: { type: 'string', enum: CONTEXTS },
    secondary: { type: ['string', 'null'], enum: [...CONTEXTS, null] },
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          name: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['label', 'name', 'evidence'],
      },
    },
  },
  required: ['summary', 'context', 'secondary', 'speakers'],
};

export interface MeetingTags {
  source: 'wispr';
  title: string;
  date: string; // YYYY-MM-DD
  context: Context;
  context2: Context | null;
  /** One-line description written by the classifier (Wispr titles are unreliable) */
  summary: string;
  /** Names from Wispr's own speaker resolution */
  namedSpeakers: string[];
  /** "Speaker N" -> name, inferred by the classifier and verified against the text */
  inferredSpeakers: Record<string, string>;
  model: string;
  taggedAt: string;
}

export interface ClassifyInput {
  title: string;
  content: string; // transcript with "Name:" / "Speaker N:" paragraph prefixes
  candidateNames: string[]; // people Wispr associated with the meeting
  roster?: string[]; // everyone Wispr knows, for rule-based speaker naming
}

/** Start, middle and end of the transcript, so long meetings are represented fairly. */
function excerpt(content: string): string {
  if (content.length <= EXCERPT_CHARS) return content;
  const part = Math.floor(EXCERPT_CHARS / 3);
  const mid = Math.floor(content.length / 2 - part / 2);
  return [
    content.slice(0, part),
    content.slice(mid, mid + part),
    content.slice(-part),
  ].join('\n\n[...]\n\n');
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Keep only speaker guesses we can check: the label must be an unnamed speaker
 * in this transcript, the name must be a known candidate or appear in the text,
 * and the evidence quote must really be in the transcript and mention the name.
 */
function verifySpeakers(
  raw: { label?: string; name?: string; evidence?: string }[],
  input: ClassifyInput
): Record<string, string> {
  const text = normalise(input.content);
  const unnamed = new Set(
    Array.from(input.content.matchAll(/^(Speaker \d+):/gm)).map((m) => m[1])
  );
  const out: Record<string, string> = {};
  // Names Wispr already attached to a speaker can't also be an unnamed speaker
  const used = new Set<string>(
    Array.from(input.content.matchAll(/^([^:\n]{1,60}):/gm))
      .map((m) => m[1])
      .filter((n) => !/^Speaker \d+$/.test(n))
      .map(normalise)
  );

  for (const s of raw || []) {
    const label = s.label?.trim();
    const name = s.name?.trim();
    const evidence = s.evidence?.trim();
    if (!label || !name || !evidence || !unnamed.has(label) || out[label]) continue;
    if (/^speaker\b/i.test(name)) continue;

    const first = normalise(name).split(' ')[0];
    if (first.length < 2) continue;

    // Prefer the full candidate name when the guess is a first name only
    const candidate = input.candidateNames.find(
      (c) => normalise(c) === normalise(name) || normalise(c).split(' ')[0] === first
    );
    const nameInText = text.includes(first);
    if (!candidate && !nameInText) continue;

    const ev = normalise(evidence);
    if (ev.length < 4 || !text.includes(ev) || !ev.includes(first)) continue;

    const finalName = candidate || name;
    if (used.has(normalise(finalName))) continue;
    used.add(normalise(finalName));
    out[label] = finalName;
  }
  return out;
}

function mergeSpeakers(primary: Record<string, string>, extra: Record<string, string>): Record<string, string> {
  const out = { ...primary };
  const taken = new Set(Object.values(out));
  for (const [label, name] of Object.entries(extra)) {
    if (!out[label] && !taken.has(name)) {
      out[label] = name;
      taken.add(name);
    }
  }
  return out;
}

export async function classifyMeeting(
  input: ClassifyInput
): Promise<{ context: Context; context2: Context | null; summary: string; inferredSpeakers: Record<string, string> }> {
  const cfg = await getClassifierConfig();
  const user = [
    `Title: ${input.title}`,
    input.candidateNames.length ? `People linked to this meeting: ${input.candidateNames.join(', ')}` : '',
    '',
    'Transcript:',
    excerpt(input.content),
  ]
    .filter((l) => l !== '')
    .join('\n');

  const res = await fetch(`${CONFIG.ollamaUrl}/api/chat`, {
    method: 'POST',
    signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CLASSIFIER_MODEL,
      stream: false,
      format: RESPONSE_SCHEMA,
      options: { temperature: 0, num_ctx: 8192, num_predict: 400 },
      messages: [
        { role: 'system', content: `${cfg.intro}\n\n${cfg.areas}\n\n${PROMPT_TAIL}` },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Classifier request failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { message?: { content?: string } };
  let parsed: { summary?: string; context?: string; secondary?: string | null; speakers?: [] } = {};
  try {
    parsed = JSON.parse(body.message?.content || '{}');
  } catch {
    // Output was cut off by num_predict (usually a runaway speakers list).
    // Recover the context fields, drop the speakers.
    const raw = body.message?.content || '';
    parsed = {
      summary: raw.match(/"summary"\s*:\s*"([^"]*)"/)?.[1],
      context: raw.match(/"context"\s*:\s*"(\w+)"/)?.[1],
      secondary: raw.match(/"secondary"\s*:\s*"(\w+)"/)?.[1] ?? null,
      speakers: [],
    };
  }

  const context = (CONTEXTS as readonly string[]).includes(parsed.context || '')
    ? (parsed.context as Context)
    : 'other';
  const secondary =
    parsed.secondary && (CONTEXTS as readonly string[]).includes(parsed.secondary) && parsed.secondary !== context
      ? (parsed.secondary as Context)
      : null;

  const summary = (parsed.summary || '').trim();
  const inferredSpeakers = mergeSpeakers(
    verifySpeakers(parsed.speakers || [], input),
    guessSpeakersByAddress(
      input.content,
      Array.from(new Set([...input.candidateNames, ...(input.roster || [])]))
    )
  );

  // Consistency rules from the config: speaker names and the model's summary
  // are more reliable than its single-word label (first matching rule wins).
  const speakers = [
    ...Array.from(input.content.matchAll(/^([^:\n]{1,60}):/gm)).map((m) => m[1]),
    ...Object.values(inferredSpeakers),
  ].join(' ');
  let ctx: Context = context;
  let ctx2: Context | null = secondary;
  const promote = (to: Context) => {
    if (ctx === to) return;
    ctx2 = ctx;
    ctx = to;
  };
  for (const rule of cfg.rules) {
    const bySpeaker = rule.speakerPattern && new RegExp(rule.speakerPattern, 'i').test(speakers);
    const bySummary = rule.summaryPattern && new RegExp(rule.summaryPattern, 'i').test(summary);
    if (bySpeaker || bySummary) {
      promote(rule.context);
      break;
    }
  }
  if (ctx2 === ctx) ctx2 = null;

  return { context: ctx, context2: ctx2, summary, inferredSpeakers };
}

// First names that are also everyday words, so they can't be matched reliably
const COMMON_WORD_NAMES = new Set([
  'will', 'mark', 'may', 'june', 'april', 'august', 'grant', 'rose', 'art', 'bill', 'pat',
  'sue', 'chase', 'hope', 'joy', 'faith', 'grace', 'dawn', 'summer', 'max', 'rich', 'frank',
  'drew', 'gene', 'jack', 'ray', 'rob', 'sky', 'storm', 'river', 'page', 'lane', 'cash',
  'product', 'design',
]);

/**
 * Rule-based speaker naming: people get addressed by name ("Sam, what do you
 * think?"). For each unnamed speaker, count how often a candidate's first name
 * shows up in the turn right before or right after theirs, spoken by someone
 * else. A name wins if it shows up at least twice and clearly more than any
 * other name. Candidates already speaking under their own name are excluded.
 */
export function guessSpeakersByAddress(
  content: string,
  candidateNames: string[]
): Record<string, string> {
  const turns = content
    .split(/\n\n+/)
    .map((p) => {
      const m = p.match(/^([^:\n]{1,60}):\s*([\s\S]*)$/);
      return m ? { speaker: m[1], text: m[2] } : null;
    })
    .filter((t): t is { speaker: string; text: string } => !!t);

  const named = new Set(turns.map((t) => t.speaker).filter((s) => !/^Speaker \d+$/.test(s)).map(normalise));
  const candidates = candidateNames.filter(
    (c) =>
      !named.has(normalise(c)) &&
      // Real "First Last" names only (Wispr's contact list has junk like "Product")
      /^[A-Z][a-z]{2,}( [A-Z][\w'-]*)+$/.test(c.trim()) &&
      !COMMON_WORD_NAMES.has(c.trim().split(' ')[0].toLowerCase())
  );
  if (candidates.length === 0) return {};

  const firstOf = (c: string) => c.trim().split(' ')[0];
  const counts = new Map<string, Map<string, number>>(); // label -> candidate -> hits

  turns.forEach((t, i) => {
    if (!/^Speaker \d+$/.test(t.speaker)) return;
    for (const j of [i - 1, i + 1]) {
      const other = turns[j];
      if (!other || other.speaker === t.speaker) continue;
      for (const c of candidates) {
        const first = firstOf(c);
        if (first.length < 3) continue;
        // Direct address only ("Sam, ...", "..., Sam?", "hey Sam"),
        // not being talked about. Case-sensitive: transcripts capitalise names.
        const n = first.replace(/[^A-Za-z]/g, '');
        const vocative = new RegExp(
          `(^|[.?!]\\s+)${n},|,\\s*${n}[.?!,]|\\b(hey|hi|hello|thanks|thank you|bye|okay|ok|yeah|morning|night),?\\s+${n}\\b`,
          'i'
        );
        if (vocative.test(other.text) && new RegExp(`\\b${n}\\b`).test(other.text)) {
          const byLabel = counts.get(t.speaker) || new Map<string, number>();
          byLabel.set(c, (byLabel.get(c) || 0) + 1);
          counts.set(t.speaker, byLabel);
        }
      }
    }
  });

  const out: Record<string, string> = {};
  const taken = new Set<string>();
  // Strongest evidence first, so two labels can't claim the same person
  const ranked = Array.from(counts.entries())
    .map(([label, byName]) => {
      const sorted = Array.from(byName.entries()).sort((a, b) => b[1] - a[1]);
      return { label, best: sorted[0], runnerUp: sorted[1]?.[1] || 0 };
    })
    .sort((a, b) => b.best[1] - a.best[1]);
  for (const { label, best, runnerUp } of ranked) {
    const [name, hits] = best;
    if (hits >= 2 && hits >= runnerUp * 2 && !taken.has(name)) {
      out[label] = name;
      taken.add(name);
    }
  }
  return out;
}

/** Replace "Speaker N:" prefixes with "Name (inferred):" */
export function applyInferredSpeakers(content: string, inferred: Record<string, string>): string {
  if (Object.keys(inferred).length === 0) return content;
  return content.replace(/^(Speaker \d+):/gm, (m, label: string) =>
    inferred[label] ? `${inferred[label]} (inferred):` : m
  );
}

// ---------------------------------------------------------------------------
// Tag cache (data/meeting-tags.json)
// ---------------------------------------------------------------------------

const TAGS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/meeting-tags.json'
);

let tagCache: Record<string, MeetingTags> | null = null;

export async function loadTags(): Promise<Record<string, MeetingTags>> {
  if (tagCache) return tagCache;
  try {
    tagCache = JSON.parse(await fs.readFile(TAGS_PATH, 'utf-8'));
  } catch {
    tagCache = {};
  }
  return tagCache!;
}

/** Re-read from disk (the MCP server is long-lived; the indexer writes the file). */
export async function reloadTags(): Promise<Record<string, MeetingTags>> {
  tagCache = null;
  return loadTags();
}

export async function saveTag(meetingId: string, tags: MeetingTags): Promise<void> {
  const all = await loadTags();
  all[meetingId] = tags;
  const tmp = `${TAGS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2));
  await fs.rename(tmp, TAGS_PATH);
}

export function participantsOf(tags: MeetingTags): string[] {
  return Array.from(new Set([...tags.namedSpeakers, ...Object.values(tags.inferredSpeakers)]));
}

// ---------------------------------------------------------------------------
// Path/title-based context for Claude sessions and strategy docs (no model)
// ---------------------------------------------------------------------------

let pathRules: { pattern: string; context: Context }[] | null = null;

function getPathRules(): { pattern: string; context: Context }[] {
  if (pathRules) return pathRules;
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    pathRules = Array.isArray(cfg.pathRules) ? cfg.pathRules : [];
  } catch {
    pathRules = [];
  }
  return pathRules!;
}

/** First matching pathRules entry from the config (regex on path + title), else 'other'. */
export function contextFromPath(p: string, title = ''): Context {
  const s = `${p} ${title}`;
  for (const rule of getPathRules()) {
    if (new RegExp(rule.pattern, 'i').test(s)) return rule.context;
  }
  return 'other';
}
