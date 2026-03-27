import { glob } from 'glob';
import * as fs from 'fs/promises';
import * as path from 'path';
import { CONFIG } from '../config/config.js';
import { chunkText } from '../utils/chunker.js';
import { getEmbeddings } from './embeddings.js';
import { addDocuments, deleteByFilePaths, getIndexedStrategyDocs, DocumentChunk } from './vectordb.js';

export interface IndexResult {
  filesIndexed: number;
  filesNew: number;
  filesModified: number;
  filesDeleted: number;
  filesUnchanged: number;
  chunksCreated: number;
  chunksDeleted: number;
  durationMs: number;
}

/**
 * Incrementally index markdown files in the strategy directory
 * Only processes new, modified, or deleted files
 */
export async function indexStrategyDocs(): Promise<IndexResult> {
  const startTime = Date.now();

  console.error(`Scanning ${CONFIG.docsPath} for markdown files...`);

  const pattern = path.join(CONFIG.docsPath, '**/*.md');
  const diskFiles = await glob(pattern, {
    ignore: ['**/node_modules/**', '**/dist/**'],
    absolute: true,
  });

  console.error(`Found ${diskFiles.length} markdown files on disk`);

  console.error('Fetching indexed files from database...');
  const indexedFiles = await getIndexedStrategyDocs();
  console.error(`Found ${indexedFiles.size} files in index`);

  const diskFileSet = new Set(diskFiles);
  const indexedFileSet = new Set(indexedFiles.keys());

  const newFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const unchangedFiles: string[] = [];

  for (const filePath of diskFiles) {
    if (!indexedFileSet.has(filePath)) {
      newFiles.push(filePath);
    } else {
      const stat = await fs.stat(filePath);
      const diskMtime = Math.round(stat.mtimeMs);
      const indexedMtime = Math.round(indexedFiles.get(filePath) || 0);

      if (diskMtime > indexedMtime) {
        modifiedFiles.push(filePath);
      } else {
        unchangedFiles.push(filePath);
      }
    }
  }

  for (const filePath of indexedFileSet) {
    if (!diskFileSet.has(filePath)) {
      deletedFiles.push(filePath);
    }
  }

  console.error(`Files: ${newFiles.length} new, ${modifiedFiles.length} modified, ${deletedFiles.length} deleted, ${unchangedFiles.length} unchanged`);

  const filesToDelete = [...deletedFiles, ...modifiedFiles];
  let chunksDeleted = 0;
  if (filesToDelete.length > 0) {
    console.error(`Deleting chunks for ${filesToDelete.length} files...`);
    chunksDeleted = await deleteByFilePaths(filesToDelete);
    console.error(`Deleted ${chunksDeleted} chunks`);
  }

  const filesToIndex = [...newFiles, ...modifiedFiles];
  let totalChunks = 0;
  const embeddingBatchSize = 20;

  if (filesToIndex.length > 0) {
    console.error(`Indexing ${filesToIndex.length} files...`);

    for (let fileIdx = 0; fileIdx < filesToIndex.length; fileIdx++) {
      const filePath = filesToIndex[fileIdx];

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        if (content.trim().length === 0) continue;

        const stat = await fs.stat(filePath);
        const fileMtime = Math.round(stat.mtimeMs);

        const chunks = chunkText(content);

        for (let chunkStart = 0; chunkStart < chunks.length; chunkStart += embeddingBatchSize) {
          const chunkBatch = chunks.slice(chunkStart, chunkStart + embeddingBatchSize);

          const embeddings = await getEmbeddings(chunkBatch.map(c => c.text));

          const documents: DocumentChunk[] = chunkBatch.map((chunk, idx) => ({
            id: `strategy-doc:${filePath}:${chunkStart + idx}`,
            text: chunk.text,
            embedding: embeddings[idx],
            metadata: {
              sourceType: 'strategy-doc' as const,
              filePath,
              fileMtime,
              chunkIndex: chunkStart + idx,
              startChar: chunk.startChar,
              endChar: chunk.endChar,
            },
          }));

          await addDocuments(documents);
          totalChunks += documents.length;
        }

        if ((fileIdx + 1) % 10 === 0 || fileIdx === filesToIndex.length - 1) {
          console.error(`Indexed ${fileIdx + 1}/${filesToIndex.length} files (${totalChunks} chunks created)`);
        }
      } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
      }
    }
  } else {
    console.error('No files need indexing - index is up to date');
  }

  const durationMs = Date.now() - startTime;

  return {
    filesIndexed: filesToIndex.length,
    filesNew: newFiles.length,
    filesModified: modifiedFiles.length,
    filesDeleted: deletedFiles.length,
    filesUnchanged: unchangedFiles.length,
    chunksCreated: totalChunks,
    chunksDeleted,
    durationMs,
  };
}

export const indexDocuments = indexStrategyDocs;
