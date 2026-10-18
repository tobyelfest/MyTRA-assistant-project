import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getPublicEnv } from '@/lib/security/public-env';

/** Request-scoped Supabase client. Authorization is enforced by Supabase Auth + database RLS. */
export async function createSupabaseServerClient() {
  const env = getPublicEnv();
  const cookieStore = cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Server Components may not mutate cookies; route handlers/actions should refresh sessions.
        }
      },
    },
  });
}

/** getUser validates the JWT with Supabase Auth; do not authorize from getSession() alone. */
export async function getAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}
