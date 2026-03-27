import { CONFIG } from '../config/config.js';

export interface Chunk {
  text: string;
  startChar: number;
  endChar: number;
}

export function chunkText(text: string): Chunk[] {
  const chunks: Chunk[] = [];

  const charsPerToken = 4;
  const chunkSizeChars = CONFIG.chunkSize * charsPerToken;
  const overlapChars = CONFIG.chunkOverlap * charsPerToken;

  if (text.length <= chunkSizeChars) {
    return [{
      text: text.trim(),
      startChar: 0,
      endChar: text.length,
    }];
  }

  let startChar = 0;

  while (startChar < text.length) {
    let endChar = Math.min(startChar + chunkSizeChars, text.length);

    if (endChar < text.length) {
      const lastSpace = text.lastIndexOf(' ', endChar);
      const lastNewline = text.lastIndexOf('\n', endChar);
      const boundary = Math.max(lastSpace, lastNewline);

      if (boundary > startChar + chunkSizeChars / 2) {
        endChar = boundary;
      }
    }

    const chunkText = text.slice(startChar, endChar).trim();

    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        startChar,
        endChar,
      });
    }

    const prevStart = startChar;
    startChar = endChar - overlapChars;

    if (endChar >= text.length || startChar <= prevStart) break;
  }

  return chunks;
}

export function getExcerpt(text: string, position: number, length: number = 200): string {
  const halfLength = Math.floor(length / 2);
  let start = Math.max(0, position - halfLength);
  let end = Math.min(text.length, position + halfLength);

  if (start > 0) {
    const nextSpace = text.indexOf(' ', start);
    if (nextSpace !== -1 && nextSpace < start + 20) {
      start = nextSpace + 1;
    }
  }

  if (end < text.length) {
    const prevSpace = text.lastIndexOf(' ', end);
    if (prevSpace !== -1 && prevSpace > end - 20) {
      end = prevSpace;
    }
  }

  let excerpt = text.slice(start, end).trim();

  if (start > 0) excerpt = '...' + excerpt;
  if (end < text.length) excerpt = excerpt + '...';

  return excerpt;
}
