import 'server-only';
import { getServerEnv } from '@/lib/security/env';
import type { ChatMessage, LLMProvider, ProviderCompletion } from '@/lib/llm/types';

export class ProviderRequestError extends Error {
  public readonly provider: LLMProvider;
  public readonly statusCode: number | null;
  public readonly code: string;

  constructor(provider: LLMProvider, code: string, statusCode: number | null = null) {
    super(`${provider} provider request failed (${code}).`);
    this.name = 'ProviderRequestError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.code = code;
  }
}

interface ProviderRequest {
  provider: LLMProvider;
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  temperature: number;
  maxOutputTokens: number;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

async function fetchJson(url: string, init: RequestInit, provider: LLMProvider, timeoutMs = 25_000): Promise<{ response: Response; body: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    const latencyMs = Date.now() - startedAt;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderRequestError(provider, 'invalid_json', response.status);
    }
    if (!response.ok) {
      // Do not copy provider error bodies into logs or user-facing errors; they may contain request details.
      throw new ProviderRequestError(provider, response.status === 429 ? 'rate_limited' : 'http_error', response.status);
    }
    return { response, body, latencyMs };
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (controller.signal.aborted) throw new ProviderRequestError(provider, 'timeout');
    throw new ProviderRequestError(provider, 'network_error');
  } finally {
    clearTimeout(timeout);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function requestGroq(input: ProviderRequest): Promise<ProviderCompletion> {
  const env = getServerEnv();
  const body = {
    model: input.model,
    messages: [
      ...(input.systemPrompt ? [{ role: 'system', content: input.systemPrompt }] : []),
      ...input.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    temperature: input.temperature,
    max_completion_tokens: input.maxOutputTokens,
    stream: false,
  };

  const { body: responseBody, latencyMs } = await fetchJson(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'groq',
  );

  const root = asRecord(responseBody);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice.message);
  const content = asText(message.content);
  if (!content) throw new ProviderRequestError('groq', 'empty_response');
  const usage = asRecord(root.usage);
  const inputTokens = finiteNonNegative(usage.prompt_tokens);
  const outputTokens = finiteNonNegative(usage.completion_tokens);

  return {
    provider: 'groq',
    model: asText(root.model) ?? input.model,
    content,
    requestId: asText(root.id),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    latencyMs,
  };
}

export async function requestGoogle(input: ProviderRequest): Promise<ProviderCompletion> {
  const env = getServerEnv();
  const embeddedSystemMessages = input.messages.filter((message) => message.role === 'system').map((message) => message.content);
  const contents = input.messages.filter((message) => message.role !== 'system').map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    },
  };
  const systemTexts = [input.systemPrompt, ...embeddedSystemMessages].filter((text): text is string => Boolean(text?.trim()));
  if (systemTexts.length) body.systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] };

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const { body: responseBody, latencyMs } = await fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': env.GOOGLE_AI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    'google',
  );

  const root = asRecord(responseBody);
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const firstCandidate = asRecord(candidates[0]);
  const candidateContent = asRecord(firstCandidate.content);
  const parts = Array.isArray(candidateContent.parts) ? candidateContent.parts : [];
  const content = parts
    .map((part) => asText(asRecord(part).text))
    .filter((part): part is string => Boolean(part))
    .join('\n')
    .trim();
  if (!content) throw new ProviderRequestError('google', 'empty_response');

  const usageMetadata = asRecord(root.usageMetadata);
  const inputTokens = finiteNonNegative(usageMetadata.promptTokenCount);
  const outputTokens = finiteNonNegative(usageMetadata.candidatesTokenCount);

  return {
    provider: 'google',
    model: input.model,
    content,
    requestId: asText(root.responseId),
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    latencyMs,
  };
}

export async function requestProvider(input: ProviderRequest): Promise<ProviderCompletion> {
  return input.provider === 'groq' ? requestGroq(input) : requestGoogle(input);
}
