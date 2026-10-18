import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdminEnv } from '@/lib/security/env';

let adminClient: SupabaseClient | undefined;

/** Server-only elevated client. Never import this file from Client Components or expose its key. */
export function createSupabaseAdminClient(): SupabaseClient {
  if (typeof window !== 'undefined') throw new Error('Supabase service-role client dilarang digunakan di browser.');
  if (adminClient) return adminClient;

  const env = getSupabaseAdminEnv();
  adminClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { 'X-Application-Name': 'chatbot-mytra-server' } },
  });
  return adminClient;
}
