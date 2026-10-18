import 'server-only';
import { getServerEnv } from '@/lib/security/env';
import { maskPII } from '@/lib/security/sanitize';

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL_ID = 'gemini-embedding-2';

export class EmbeddingError extends Error {
  constructor(message = 'Embedding service tidak tersedia.') {
    super(message);
    this.name = 'EmbeddingError';
  }
}

interface GoogleEmbeddingResponse {
  embedding?: { values?: unknown };
  error?: { code?: number; status?: string };
}

/**
 * Generates a 768-dimensional vector compatible with knowledge_base.embedding.
 * text-embedding-004 was shut down on 14 Jan 2026, so the supported replacement
 * gemini-embedding-2 is used with outputDimensionality=768.
 */
export async function embedText(text: string): Promise<number[]> {
  const cleaned = maskPII(text).trim();
  if (!cleaned) throw new EmbeddingError('Teks embedding tidak boleh kosong.');
  // Stay comfortably below the model's token limit, including Indonesian text and punctuation.
  const boundedText = cleaned.slice(0, 12_000);
  const env = getServerEnv();
  const model = env.GOOGLE_EMBEDDING_MODEL || EMBEDDING_MODEL_ID;
  if (model !== EMBEDDING_MODEL_ID) {
    throw new EmbeddingError(`Model embedding tidak sesuai. Gunakan ${EMBEDDING_MODEL_ID} untuk menjaga konsistensi dimensi/ruang vektor.`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': env.GOOGLE_AI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: { parts: [{ text: boundedText }] },
          output_dimensionality: EMBEDDING_DIMENSIONS,
        }),
        cache: 'no-store',
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      // Do not forward the Google response body; it may contain implementation details.
      throw new EmbeddingError(`Embedding service menolak permintaan (HTTP ${response.status}).`);
    }
    const payload = await response.json() as GoogleEmbeddingResponse;
    const values = payload.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError('Dimensi embedding tidak sesuai dengan skema database.');
    }
    const vector = values.map((value) => Number(value));
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingError('Embedding berisi nilai numerik yang tidak valid.');
    }
    return vector;
  } catch (error) {
    if (error instanceof EmbeddingError) throw error;
    if (controller.signal.aborted) throw new EmbeddingError('Embedding service timeout.');
    throw new EmbeddingError();
  } finally {
    clearTimeout(timeout);
  }
}
