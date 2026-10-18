export const MAX_CHAT_INPUT_LENGTH = 4_000;

export type InputRejectionReason = 'empty' | 'too_long' | 'prompt_injection';
export type SanitizedInputResult =
  | { ok: true; text: string }
  | { ok: false; reason: InputRejectionReason; message: string };

// These are detection heuristics, not a complete defense against prompt injection.
// Tool authorization and untrusted-context isolation must still be enforced server-side.
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\s+(all\s+)?(previous|prior|above|earlier|system|developer)\s+(instructions?|rules?|prompts?)\b/i,
  /\b(ignore|disregard|forget)\s+(all\s+)?(instructions?|rules?)\b/i,
  /\b(reveal|show|print|repeat|dump|leak)\s+(the\s+)?(system|developer|hidden)\s+(prompt|instructions?)\b/i,
  /\b(system prompt|developer message|hidden instructions?)\b/i,
  /\b(jailbreak|developer mode|DAN mode|act as (the )?(system|developer))\b/i,
  /\b(abaikan|lupakan|kesampingkan|lewati|bypass)\s+(semua\s+)?(instruksi|aturan|perintah)\s+(sebelumnya|di\s+atas|sistem|developer)\b/i,
  /\b(tampilkan|bocorkan|ungkapkan|cetak)\s+(prompt|instruksi|perintah)\s+(sistem|tersembunyi|developer)\b/i,
];

function decodeCommonEntities(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Remove active HTML payloads, tags, null bytes, and unsafe control characters. */
export function stripHtmlAndControls(input: string): string {
  const normalized = decodeCommonEntities(input)
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

  return normalized
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function detectPromptInjection(input: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(input));
}

/** Validate and sanitize text before application-level routing or an LLM call. */
export function sanitizeChatInput(input: unknown): SanitizedInputResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return { ok: false, reason: 'empty', message: 'Pesan tidak boleh kosong.' };
  }
  // Check raw size first to avoid expensive processing of oversized inputs.
  if (input.length > MAX_CHAT_INPUT_LENGTH) {
    return { ok: false, reason: 'too_long', message: `Pesan maksimal ${MAX_CHAT_INPUT_LENGTH} karakter.` };
  }

  const text = stripHtmlAndControls(input);
  if (!text) return { ok: false, reason: 'empty', message: 'Pesan tidak boleh kosong.' };
  if (detectPromptInjection(text)) {
    return {
      ok: false,
      reason: 'prompt_injection',
      message: 'Pesan terdeteksi berisi instruksi yang tidak dapat diproses. Silakan ajukan pertanyaan secara langsung.',
    };
  }
  return { ok: true, text };
}

/** Mask Indonesian/international email addresses and phone-number-like strings before sending text to an LLM. */
export function maskPII(input: string): string {
  return input
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL_REDACTED]')
    .replace(/(?<!\w)(?:\+?62|0)[\s().-]?(?:\d[\s().-]?){8,13}(?!\w)/g, '[PHONE_REDACTED]');
}

/** Single helper for routes: rejects unsafe input and returns PII-masked text ready for an LLM. */
export function prepareInputForLLM(input: unknown): SanitizedInputResult {
  const sanitized = sanitizeChatInput(input);
  if (!sanitized.ok) return sanitized;
  return { ok: true, text: maskPII(sanitized.text) };
}
