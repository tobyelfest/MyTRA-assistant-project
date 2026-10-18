import 'server-only';
import { createSupabaseServerClient } from '@/lib/db/supabase-server';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';

export class AuthenticationRequiredError extends Error {
  constructor() {
    super('Autentikasi diperlukan.');
    this.name = 'AuthenticationRequiredError';
  }
}

export class AdminRequiredError extends Error {
  constructor() {
    super('Akses admin diperlukan.');
    this.name = 'AdminRequiredError';
  }
}

function clampLimit(value: number, maximum = 100): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(Math.trunc(value), maximum));
}

/** Confirms the user from the signed session; never accepts a user ID supplied by the request body. */
export async function requireAuthenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new AuthenticationRequiredError();
  return { supabase, user: data.user };
}

/** Admin status is read from the database for the authenticated user, not from client-controlled metadata. */
export async function requireAdmin() {
  const { supabase, user } = await requireAuthenticatedUser();
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (error || profile?.role !== 'admin') throw new AdminRequiredError();
  return { user, profile };
}

export async function getMyConversations(limit = 20) {
  const { supabase, user } = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, status, created_at, updated_at')
    .eq('user_id', user.id)
    .order('updated_at', { ascending: false })
    .limit(clampLimit(limit));
  if (error) throw new Error('Gagal mengambil percakapan.');
  return data ?? [];
}

export async function getMyTickets(limit = 20) {
  const { supabase, user } = await requireAuthenticatedUser();
  const { data, error } = await supabase
    .from('tickets')
    .select('id, subject, status, priority, created_at, updated_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(clampLimit(limit));
  if (error) throw new Error('Gagal mengambil tiket.');
  return data ?? [];
}

/** Explicit admin gate before using service_role; service_role itself bypasses RLS. */
export async function getAdminOverviewStats() {
  await requireAdmin();
  const admin = createSupabaseAdminClient();

  const [tickets, conversations, messages, usage] = await Promise.all([
    admin.from('tickets').select('id', { count: 'exact', head: true }),
    admin.from('conversations').select('id', { count: 'exact', head: true }),
    admin.from('messages').select('id', { count: 'exact', head: true }),
    admin.from('token_usage').select('id', { count: 'exact', head: true }),
  ]);

  const firstError = [tickets.error, conversations.error, messages.error, usage.error].find(Boolean);
  if (firstError) throw new Error('Gagal mengambil statistik admin.');

  return {
    tickets: tickets.count ?? 0,
    conversations: conversations.count ?? 0,
    messages: messages.count ?? 0,
    usageRecords: usage.count ?? 0,
  };
}
