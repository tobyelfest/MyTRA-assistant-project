export type LLMProvider = 'groq' | 'google';
export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderCompletion {
  provider: LLMProvider;
  model: string;
  content: string;
  requestId: string | null;
  usage: ProviderUsage;
  latencyMs: number;
}

export interface CompletionInput {
  messages: ChatMessage[];
  systemPrompt?: string;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  userId?: string | null;
  conversationId?: string | null;
  trackUsage?: boolean;
}
