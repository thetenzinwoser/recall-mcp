import * as fs from 'fs/promises';
import * as path from 'path';
import { GranolaTranscript } from './granola-api.js';

const DEFAULT_EXPORT_PATH = path.join(
  process.env.HOME || '~',
  'Documents/granola-transcripts'
);

export interface ExportOptions {
  exportPath?: string;
}

export interface ExportResult {
  exported: number;
  skipped: number;
  exportPath: string;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-$/, '');
}

function getFilename(transcript: GranolaTranscript): string {
  const date = transcript.meetingDate || 'undated';
  const slug = slugify(transcript.meetingTitle || 'untitled');
  return `${date}-${slug}.md`;
}

function formatMarkdown(transcript: GranolaTranscript): string {
  const frontmatter = [
    '---',
    `title: "${transcript.meetingTitle.replace(/"/g, '\\"')}"`,
    `date: ${transcript.meetingDate}`,
    `meeting_id: ${transcript.meetingId}`,
    `segments: ${transcript.segmentCount}`,
    '---',
    '',
  ].join('\n');

  return frontmatter + transcript.content;
}

async function getExportedMeetingIds(exportPath: string): Promise<Set<string>> {
  const ids = new Set<string>();

  try {
    const files = await fs.readdir(exportPath);

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const filePath = path.join(exportPath, file);
      const content = await fs.readFile(filePath, 'utf-8');

      const match = content.match(/^meeting_id:\s*(.+)$/m);
      if (match) {
        ids.add(match[1].trim());
      }
    }
  } catch (error) {
    // Directory might not exist yet
  }

  return ids;
}

export async function exportTranscripts(
  transcripts: GranolaTranscript[],
  options: ExportOptions = {}
): Promise<ExportResult> {
  const exportPath = options.exportPath || DEFAULT_EXPORT_PATH;

  await fs.mkdir(exportPath, { recursive: true });

  const exportedIds = await getExportedMeetingIds(exportPath);

  let exported = 0;
  let skipped = 0;

  for (const transcript of transcripts) {
    if (exportedIds.has(transcript.meetingId)) {
      skipped++;
      continue;
    }

    if (!transcript.content || transcript.content.trim().length === 0) {
      skipped++;
      continue;
    }

    const filename = getFilename(transcript);
    const filePath = path.join(exportPath, filename);
    const markdown = formatMarkdown(transcript);

    await fs.writeFile(filePath, markdown, 'utf-8');
    exported++;
  }

  return {
    exported,
    skipped,
    exportPath,
  };
}

export function getDefaultExportPath(): string {
  return DEFAULT_EXPORT_PATH;
}
