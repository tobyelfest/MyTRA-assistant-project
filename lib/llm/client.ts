import 'server-only';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';
import { recordProviderStatus, trackLLMUsage } from '@/lib/llm/usage-tracker';
import { ProviderRequestError, requestProvider } from '@/lib/llm/providers';
import type { CompletionInput, LLMProvider, ProviderCompletion } from '@/lib/llm/types';

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  groq: 'llama-3.3-70b-versatile',
  google: 'gemini-2.5-flash',
};

const ALLOWED_MODELS: Record<LLMProvider, ReadonlySet<string>> = {
  groq: new Set(['llama-3.3-70b-versatile']),
  google: new Set(['gemini-2.5-flash']),
};

export class LLMUnavailableError extends Error {
  constructor() {
    super('Layanan AI sedang tidak tersedia. Silakan coba kembali beberapa saat lagi.');
    this.name = 'LLMUnavailableError';
  }
}

async function readActiveConfig(): Promise<{ provider: LLMProvider; model: string } | null> {
  try {
    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from('agent_configs')
      .select('config, is_enabled')
      .eq('agent_key', 'llm_provider')
      .maybeSingle();
    if (error || !data || data.is_enabled === false) return null;
    const config = data.config && typeof data.config === 'object' ? data.config as Record<string, unknown> : {};
    const provider = config.provider === 'google' ? 'google' : config.provider === 'groq' ? 'groq' : null;
    if (!provider) return null;
    const requestedModel = typeof config.model === 'string' ? config.model : DEFAULT_MODELS[provider];
    const model = ALLOWED_MODELS[provider].has(requestedModel) ? requestedModel : DEFAULT_MODELS[provider];
    return { provider, model };
  } catch {
    return null;
  }
}

function safeModel(provider: LLMProvider, model?: string): string {
  return model && ALLOWED_MODELS[provider].has(model) ? model : DEFAULT_MODELS[provider];
}

function otherProvider(provider: LLMProvider): LLMProvider {
  return provider === 'groq' ? 'google' : 'groq';
}

export async function chatCompletion(input: CompletionInput): Promise<ProviderCompletion> {
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new Error('LLM membutuhkan setidaknya satu pesan.');
  }
  const configured = input.provider ? null : await readActiveConfig();
  const primary: LLMProvider = input.provider ?? configured?.provider ?? 'groq';
  const primaryModel = safeModel(primary, input.model ?? (configured?.provider === primary ? configured.model : undefined));
  const fallback = otherProvider(primary);
  const attempts: Array<{ provider: LLMProvider; model: string }> = [
    { provider: primary, model: primaryModel },
    { provider: fallback, model: DEFAULT_MODELS[fallback] },
  ];
  const failures: Array<{ provider: LLMProvider; error: unknown }> = [];

  for (const [index, attempt] of attempts.entries()) {
    try {
      const completion = await requestProvider({
        provider: attempt.provider,
        model: attempt.model,
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        temperature: input.temperature ?? 0.25,
        maxOutputTokens: input.maxOutputTokens ?? 900,
      });
      await recordProviderStatus(attempt.provider, 'healthy', completion.latencyMs, null);
      if (input.trackUsage !== false) await trackLLMUsage(completion, { userId: input.userId, conversationId: input.conversationId });
      if (index > 0 && failures[0]?.error instanceof ProviderRequestError) {
        await recordProviderStatus(failures[0].provider, 'down', null, failures[0].error.code);
      }
      return completion;
    } catch (error) {
      const safeError = error instanceof ProviderRequestError ? error : new ProviderRequestError(attempt.provider, 'unknown_error');
      failures.push({ provider: attempt.provider, error: safeError });
      await recordProviderStatus(attempt.provider, 'down', null, safeError.code);
    }
  }

  // No provider payload, API key, prompt, or response body is exposed in the public exception.
  throw new LLMUnavailableError();
}

export async function getActiveProviderConfig(): Promise<{ provider: LLMProvider; model: string }> {
  return (await readActiveConfig()) ?? { provider: 'groq', model: DEFAULT_MODELS.groq };
}

export const DEFAULT_LLM_MODELS = DEFAULT_MODELS;
