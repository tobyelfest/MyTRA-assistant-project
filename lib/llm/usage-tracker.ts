import 'server-only';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';
import type { LLMProvider, ProviderCompletion } from '@/lib/llm/types';

interface UsageContext {
  userId?: string | null;
  conversationId?: string | null;
}

function configuredPrice(variableName: string): number | null {
  const raw = process.env[variableName];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function estimateCostUsd(completion: ProviderCompletion): number {
  const prefix = completion.provider === 'groq' ? 'GROQ' : 'GOOGLE';
  const inputPrice = configuredPrice(`${prefix}_INPUT_PRICE_PER_MILLION`);
  const outputPrice = configuredPrice(`${prefix}_OUTPUT_PRICE_PER_MILLION`);
  // Keep the DB's NOT NULL column compatible; zero is an unconfigured estimate, not proof of free usage.
  if (inputPrice === null || outputPrice === null) return 0;
  const cost = (completion.usage.inputTokens * inputPrice + completion.usage.outputTokens * outputPrice) / 1_000_000;
  return Math.max(0, Math.round(cost * 100_000_000) / 100_000_000);
}

export async function trackLLMUsage(completion: ProviderCompletion, context: UsageContext = {}): Promise<void> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from('token_usage').insert({
      user_id: context.userId ?? null,
      conversation_id: context.conversationId ?? null,
      provider: completion.provider,
      model: completion.model.slice(0, 160),
      input_tokens: completion.usage.inputTokens,
      output_tokens: completion.usage.outputTokens,
      estimated_cost_usd: estimateCostUsd(completion),
      request_id: completion.requestId?.slice(0, 200) ?? null,
    });
    if (error) console.error(JSON.stringify({ event: 'llm_usage_insert_failed', code: error.code }));
  } catch {
    console.error(JSON.stringify({ event: 'llm_usage_tracking_unavailable' }));
  }
}

export async function recordProviderStatus(
  provider: LLMProvider,
  status: 'healthy' | 'degraded' | 'down',
  latencyMs: number | null,
  errorCode?: string | null,
): Promise<void> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from('provider_status').upsert({
      provider,
      status,
      last_checked_at: new Date().toISOString(),
      latency_ms: latencyMs === null ? null : Math.max(0, Math.trunc(latencyMs)),
      last_error_code: errorCode?.slice(0, 100) ?? null,
    }, { onConflict: 'provider' });
    if (error) console.error(JSON.stringify({ event: 'provider_status_update_failed', code: error.code }));
  } catch {
    console.error(JSON.stringify({ event: 'provider_status_update_unavailable' }));
  }
}
