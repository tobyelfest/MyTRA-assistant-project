import 'server-only';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';
import { embedText } from '@/lib/rag/embed';

export const KNOWLEDGE_CATEGORIES = ['layanan', 'perusahaan', 'kontak', 'legal', 'event'] as const;
export type KnowledgeCategory = typeof KNOWLEDGE_CATEGORIES[number];

export interface KnowledgeChunk {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  source_url: string | null;
  similarity: number;
}

export interface RetrieveOptions {
  limit?: number;
  threshold?: number;
  category?: KnowledgeCategory;
}

export class RetrievalError extends Error {
  constructor(message = 'Knowledge base sementara tidak dapat diakses.') {
    super(message);
    this.name = 'RetrievalError';
  }
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().slice(0, 2048);
  } catch {
    return null;
  }
}

/** Server-side-only vector retrieval. The SQL RPC is granted to service_role only. */
export async function retrieveKnowledge(query: string, options: RetrieveOptions = {}): Promise<KnowledgeChunk[]> {
  const cleanedQuery = query.trim();
  if (!cleanedQuery) return [];
  const limit = Math.max(1, Math.min(10, Math.trunc(options.limit ?? 5)));
  const threshold = Math.max(0, Math.min(1, options.threshold ?? 0.28));
  if (options.category && !KNOWLEDGE_CATEGORIES.includes(options.category)) {
    throw new RetrievalError('Kategori knowledge base tidak valid.');
  }

  try {
    const embedding = await embedText(cleanedQuery);
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase.rpc('match_knowledge_base', {
      query_embedding: embedding,
      match_threshold: threshold,
      match_count: limit,
      filter_category: options.category ?? null,
    });
    if (error) throw new RetrievalError();
    const rows = Array.isArray(data) ? data as Array<Record<string, unknown>> : [];

    return rows.flatMap((row): KnowledgeChunk[] => {
      const id = typeof row.id === 'string' ? row.id : '';
      const title = typeof row.title === 'string' ? row.title : '';
      const content = typeof row.content === 'string' ? row.content : '';
      const category = typeof row.category === 'string' && KNOWLEDGE_CATEGORIES.includes(row.category as KnowledgeCategory)
        ? row.category as KnowledgeCategory
        : null;
      const similarity = typeof row.similarity === 'number' ? row.similarity : Number(row.similarity);
      if (!id || !title || !content || !category || !Number.isFinite(similarity)) return [];
      return [{
        id,
        title: title.slice(0, 300),
        content: content.slice(0, 12_000),
        category,
        source_url: safeSourceUrl(row.source_url),
        similarity: Math.max(0, Math.min(1, similarity)),
      }];
    });
  } catch (error) {
    if (error instanceof RetrievalError) throw error;
    throw new RetrievalError();
  }
}
