import { CONFIG } from '../config/config.js';

/**
 * Get embedding for a single text using Ollama's local API
 */
export async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch(`${CONFIG.ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.embeddingModel,
      input: text,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embedding error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings[0];
}

/**
 * Get embeddings for multiple texts using Ollama's local API
 * Ollama's /api/embed supports batch input natively
 */
export async function getEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await fetch(`${CONFIG.ollamaUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.embeddingModel,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama embedding error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  return data.embeddings;
}
