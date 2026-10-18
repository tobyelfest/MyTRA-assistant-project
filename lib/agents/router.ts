import 'server-only';
import { sanitizeChatInput } from '@/lib/security/sanitize';

export type UserRoute = 'faq' | 'layanan' | 'eskalasi';

export interface RouteDecision {
  route: UserRoute;
  reason: 'human_request_or_complaint' | 'service_intent' | 'general_information';
}

const ESCALATION_PATTERNS = [
  /\b(komplain|keluhan|pengaduan|kecewa|protes|sengketa)\b/i,
  /\b(bicara|berbicara|terhubung|hubungkan)\b.{0,30}\b(admin|staf|staff|petugas|manusia|konsultan)\b/i,
  /\b(hubungi|kontak)\b.{0,25}\b(manusia|staf|staff|admin|petugas)\b/i,
  /\b(urgent|darurat|segera ditangani|eskalasi)\b/i,
];

const SERVICE_PATTERNS = [
  /\b(layanan|jasa|biaya|tarif|harga|penawaran|konsultasi)\b/i,
  /\b(akuntansi|pembukuan|laporan keuangan|audit|pajak|pph|ppn|spt|npwp|faktur pajak|rekonsiliasi)\b/i,
  /\b(pelaporan|pembayaran pajak|kepatuhan pajak|tax review|tax planning)\b/i,
];

/** Deterministic first-pass router; the LLM is not allowed to choose its own privilege level. */
export function routeUserMessage(input: unknown): RouteDecision {
  const sanitized = sanitizeChatInput(input);
  if (!sanitized.ok) throw new Error(sanitized.message);
  const message = sanitized.text;
  if (ESCALATION_PATTERNS.some((pattern) => pattern.test(message))) {
    return { route: 'eskalasi', reason: 'human_request_or_complaint' };
  }
  if (SERVICE_PATTERNS.some((pattern) => pattern.test(message))) {
    return { route: 'layanan', reason: 'service_intent' };
  }
  return { route: 'faq', reason: 'general_information' };
}
