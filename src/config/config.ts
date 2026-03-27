import { z } from 'zod';
import * as os from 'os';
import * as path from 'path';

const configSchema = z.object({
  docsPath: z.string(),
  collectionName: z.string().default('recall-docs'),
  ollamaUrl: z.string().default('http://localhost:11434'),
  embeddingModel: z.string().default('nomic-embed-text'),
  chunkSize: z.number().default(500),
  chunkOverlap: z.number().default(50),
});

export type Config = z.infer<typeof configSchema>;

export const CONFIG: Config = configSchema.parse({
  docsPath: process.env.DOCS_PATH || path.join(os.homedir(), 'docs'),
  collectionName: 'recall-docs',
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  embeddingModel: process.env.EMBEDDING_MODEL || 'nomic-embed-text',
  chunkSize: 500,
  chunkOverlap: 50,
});

export function validateConfig(): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  // No API key needed - Ollama runs locally

  return {
    isValid: errors.length === 0,
    errors,
  };
}
