import 'server-only';
import { createHmac } from 'node:crypto';

/** Stable pseudonymization for IP/user identifiers. Uses an application secret to resist offline enumeration. */
export function hashSensitiveIdentifier(value: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET minimal 32 karakter diperlukan untuk hashing identifier.');
  }
  return createHmac('sha256', secret).update(value).digest('hex');
}
