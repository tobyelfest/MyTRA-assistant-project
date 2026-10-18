import 'server-only';
import { prepareInputForLLM } from '@/lib/security/sanitize';
import { routeUserMessage, type UserRoute } from '@/lib/agents/router';
import { chatCompletion } from '@/lib/llm/client';
import { buildRagPrompt, type UserAgentMode } from '@/lib/rag/prompt-builder';
import { retrieveKnowledge, type KnowledgeChunk } from '@/lib/rag/retrieve';
import type { LLMProvider, ProviderUsage } from '@/lib/llm/types';

export interface PublicChatInput {
  message: unknown;
  userId?: string | null;
  conversationId?: string | null;
  provider?: LLMProvider;
}

export interface PublicChatResult {
  route: UserRoute;
  answer: string;
  sources: Array<{ id: string; title: string; category: string; sourceUrl: string | null; similarity: number }>;
  provider: LLMProvider | 'system';
  model: string;
  usage?: ProviderUsage;
}

function asKnowledgeText(chunks: KnowledgeChunk[]): string {
  return chunks.map((chunk) => `${chunk.title}\n${chunk.content}`).join('\n');
}

async function answerRagMode(
  question: string,
  chunks: KnowledgeChunk[],
  mode: UserAgentMode,
  route: UserRoute,
  context: Pick<PublicChatInput, 'userId' | 'conversationId' | 'provider'>,
): Promise<PublicChatResult> {
  const prompt = buildRagPrompt(question, chunks, mode);
  const completion = await chatCompletion({
    systemPrompt: prompt.systemPrompt,
    messages: prompt.messages,
    provider: context.provider,
    temperature: 0.25,
    maxOutputTokens: 850,
    userId: context.userId,
    conversationId: context.conversationId,
  });
  return {
    route,
    answer: completion.content.trim(),
    sources: prompt.sources,
    provider: completion.provider,
    model: completion.model,
    usage: completion.usage,
  };
}

/** Public-facing agent pipeline. Only sanitized + PII-masked user text is sent outside the app. */
export async function handlePublicChat(input: PublicChatInput): Promise<PublicChatResult> {
  const prepared = prepareInputForLLM(input.message);
  if (!prepared.ok) throw new Error(prepared.message);
  const question = prepared.text;
  const routeDecision = routeUserMessage(question);
  let chunks: KnowledgeChunk[];
  try {
    chunks = await retrieveKnowledge(question, { limit: 6, threshold: 0.27 });
  } catch {
    return {
      route: routeDecision.route,
      answer: 'Maaf, basis pengetahuan resmi sedang tidak dapat diakses. Agar saya tidak memberi informasi yang keliru, silakan coba kembali beberapa saat lagi.',
      sources: [],
      provider: 'system',
      model: 'system-fallback',
    };
  }

  if (routeDecision.route === 'eskalasi') {
    // This agent does not claim to send a message or create a ticket. It prepares a safe handoff response.
    const contactChunks = chunks.filter((chunk) => chunk.category === 'kontak' || chunk.category === 'perusahaan');
    const prompt = buildRagPrompt(question, contactChunks.length ? contactChunks : chunks, 'eskalasi');
    const completion = await chatCompletion({
      systemPrompt: `${prompt.systemPrompt}\n\nTugas khusus eskalasi: akui kebutuhan pengguna, rangkum inti permintaan secara singkat bila relevan, dan jelaskan cara menghubungi manusia hanya bila didukung referensi. Tegaskan bahwa Anda belum membuat tiket atau mengirim pemberitahuan.`,
      messages: prompt.messages,
      provider: input.provider,
      temperature: 0.2,
      maxOutputTokens: 550,
      userId: input.userId,
      conversationId: input.conversationId,
    });
    return {
      route: 'eskalasi',
      answer: completion.content.trim(),
      sources: prompt.sources,
      provider: completion.provider,
      model: completion.model,
      usage: completion.usage,
    };
  }

  return answerRagMode(
    question,
    chunks,
    routeDecision.route === 'layanan' ? 'layanan' : 'faq',
    routeDecision.route,
    input,
  );
}

/** Exported for route-level previews and offline tests; not a guarantee of semantic correctness. */
export function classifyPublicMessage(message: unknown): UserRoute {
  return routeUserMessage(message).route;
}

export function formatRetrievedContext(chunks: KnowledgeChunk[]): string {
  return asKnowledgeText(chunks).slice(0, 20_000);
}
