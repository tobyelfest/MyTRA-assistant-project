import 'server-only';
import { hashSensitiveIdentifier } from '@/lib/security/hash';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';

export type AuditAction =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.logout'
  | 'admin.tool_call'
  | 'admin.model_switch'
  | 'security.rate_limit_hit'
  | 'security.authorization_denied'
  | 'security.configuration_error'
  | (string & {});

export interface AuditLogInput {
  actorId?: string | null;
  action: AuditAction;
  resourceType?: string | null;
  resourceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditLogResult {
  ok: boolean;
  error?: string;
}

const SENSITIVE_KEY = /(authorization|cookie|password|secret|api.?key|token|email|phone|content|prompt|message|query|sql)/i;

function safeMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[MAX_DEPTH]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeMetadata(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key.slice(0, 80)] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeMetadata(item, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 100);
}

export function hashAuditIdentifier(value: string): string {
  return hashSensitiveIdentifier(value);
}

/**
 * Writes a minimized audit record. Never pass raw chat content, credentials, or full PII in metadata.
 * Callers performing privileged mutations should stop if this function returns { ok: false }.
 */
export async function writeAuditLog(input: AuditLogInput): Promise<AuditLogResult> {
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from('audit_logs').insert({
      actor_id: input.actorId ?? null,
      action: input.action,
      resource_type: input.resourceType?.slice(0, 100) ?? null,
      resource_id: input.resourceId?.slice(0, 200) ?? null,
      ip_hash: input.ipAddress ? hashAuditIdentifier(input.ipAddress) : null,
      user_agent: input.userAgent?.slice(0, 400) ?? null,
      metadata: safeMetadata(input.metadata ?? {}) as Record<string, unknown>,
    });
    if (error) {
      console.error(JSON.stringify({ event: 'audit_write_failed', code: error.code }));
      return { ok: false, error: 'audit_write_failed' };
    }
    return { ok: true };
  } catch {
    // Do not log input values here. The failure must be visible to callers.
    console.error(JSON.stringify({ event: 'audit_write_unavailable' }));
    return { ok: false, error: 'audit_write_unavailable' };
  }
}
