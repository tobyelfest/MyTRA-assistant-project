'use client';

import { createBrowserClient } from '@supabase/ssr';
import { getPublicEnv } from '@/lib/security/public-env';

let browserClient: ReturnType<typeof createBrowserClient> | undefined;

/** Use only in Client Components. This client has publishable/anon privileges and relies on RLS. */
export function createSupabaseBrowserClient() {
  if (browserClient) return browserClient;
  const env = getPublicEnv();
  browserClient = createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  return browserClient;
}
