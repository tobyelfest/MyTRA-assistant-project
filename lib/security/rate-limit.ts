import 'server-only';
import { hashSensitiveIdentifier } from '@/lib/security/hash';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { getRateLimitEnv } from '@/lib/security/env';
import { writeAuditLog } from '@/lib/security/audit-log';

export type RateLimitScope = 'user_chat' | 'admin_chat' | 'login';
type Policy = { limit: number; window: '1 m' | '15 m'; label: string };

const POLICIES: Record<RateLimitScope, Policy> = {
  user_chat: { limit: 15, window: '1 m', label: 'user_chat' },
  admin_chat: { limit: 60, window: '1 m', label: 'admin_chat' },
  login: { limit: 5, window: '15 m', label: 'login' },
};

const limiterCache = new Map<RateLimitScope, Ratelimit>();

function getLimiter(scope: RateLimitScope): Ratelimit {
  const cached = limiterCache.get(scope);
  if (cached) return cached;

  // Fail closed when Redis is misconfigured; never silently disable rate limiting in production.
  const env = getRateLimitEnv();
  const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  const policy = POLICIES[scope];
  const limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(policy.limit, policy.window),
    prefix: `mytra:ratelimit:${scope}`,
    analytics: false,
    ephemeralCache: new Map(),
  });
  limiterCache.set(scope, limiter);
  return limiter;
}

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfterSeconds: number;
}

/** Identifier should be an authenticated user ID when available, otherwise a trusted edge/client-IP value. */
export async function checkRateLimit(scope: RateLimitScope, identifier: string): Promise<RateLimitResult> {
  if (!identifier || identifier.length > 300) throw new Error('Rate-limit identifier tidak valid.');
  const policy = POLICIES[scope];
  const key = hashSensitiveIdentifier(identifier);
  const result = await getLimiter(scope).limit(key);
  const output: RateLimitResult = {
    success: result.success,
    limit: result.limit,
    remaining: result.remaining,
    reset: result.reset,
    retryAfterSeconds: result.success ? 0 : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
  };

  if (!result.success) {
    // Best-effort telemetry. The request is denied regardless of audit availability.
    await writeAuditLog({
      action: 'security.rate_limit_hit',
      metadata: { scope: policy.label, identifier_hash: key, limit: result.limit, reset: result.reset },
    });
  }
  return output;
}

/**
 * Prefer Vercel's edge-provided client address. Only trust forwarded headers when the app is behind
 * a known proxy that overwrites them; do not deploy this unchanged behind an arbitrary proxy chain.
 */
export function getRateLimitIdentifier(headers: Headers, authenticatedUserId?: string | null): string {
  if (authenticatedUserId) return `user:${authenticatedUserId}`;
  const vercelIp = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
  const forwardedIp = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip')?.trim();
  const ip = vercelIp || forwardedIp || realIp;
  if (!ip) throw new Error('Alamat klien tidak tersedia untuk rate limiting.');
  return `ip:${ip}`;
}
