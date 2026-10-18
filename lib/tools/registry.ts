import 'server-only';
import { requireAdmin } from '@/lib/db/queries';
import { createSupabaseAdminClient } from '@/lib/db/supabase-admin';
import { writeAuditLog } from '@/lib/security/audit-log';
import { maskPII, stripHtmlAndControls } from '@/lib/security/sanitize';
import { EMBEDDING_MODEL_ID } from '@/lib/rag/embed';
import { embedText } from '@/lib/rag/embed';
import { ADMIN_TOOL_DEFINITIONS, type AdminToolName } from '@/lib/tools/definitions';

export interface ToolExecutionContext {
  actorId: string;
  conversationId?: string | null;
  /** Separate admin confirmation field supplied by a second authenticated request; never parsed from model arguments. */
  confirmed: boolean;
  confirmationId?: string | null;
}

export interface ToolExecutionResult {
  ok: boolean;
  code?: 'confirmation_required' | 'invalid_arguments' | 'not_found' | 'unauthorized' | 'audit_unavailable' | 'operation_failed';
  message: string;
  data?: unknown;
  confirmationRequired?: boolean;
}

type Args = Record<string, unknown>;

function isRecord(value: unknown): value is Args {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sinceDays(daysValue: unknown): string {
  const days = typeof daysValue === 'number' && Number.isFinite(daysValue) ? Math.max(1, Math.min(90, Math.trunc(daysValue))) : 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function countValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString().slice(0, 2048) : null;
  } catch {
    return null;
  }
}

async function auditTool(actorId: string, tool: AdminToolName, confirmed: boolean): Promise<boolean> {
  const audit = await writeAuditLog({
    actorId,
    action: 'admin.tool_call',
    resourceType: 'admin_tool',
    resourceId: tool,
    metadata: { tool, confirmed, outcome: confirmed ? 'requested' : 'invoked' },
  });
  return audit.ok;
}

async function countTable(table: 'conversations' | 'messages' | 'tickets', since?: string, status?: string): Promise<number> {
  const supabase = createSupabaseAdminClient();
  let query = supabase.from(table).select('id', { count: 'exact', head: true });
  if (since) query = query.gte('created_at', since);
  if (status) query = query.eq('status', status);
  const { count, error } = await query;
  if (error) throw new Error('query_failed');
  return countValue(count);
}

async function getChatStats(days: number): Promise<ToolExecutionResult> {
  const since = sinceDays(days);
  const [conversations, openConversations, messages, userMessages] = await Promise.all([
    countTable('conversations', since),
    countTable('conversations', since, 'open'),
    countTable('messages', since),
    (async () => {
      const supabase = createSupabaseAdminClient();
      const { count, error } = await supabase.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', since).eq('role', 'user');
      if (error) throw new Error('query_failed');
      return countValue(count);
    })(),
  ]);
  return { ok: true, message: `Statistik percakapan ${days} hari terakhir berhasil dihitung.`, data: { days, conversations, openConversations, messages, userMessages, since } };
}

async function getTicketStats(): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const statuses = ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'] as const;
  const priorities = ['low', 'normal', 'high', 'urgent'] as const;
  const statusCounts = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('status', status);
    if (error) throw new Error('query_failed');
    return [status, countValue(count)] as const;
  }));
  const priorityCounts = await Promise.all(priorities.map(async (priority) => {
    const { count, error } = await supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('priority', priority);
    if (error) throw new Error('query_failed');
    return [priority, countValue(count)] as const;
  }));
  return { ok: true, message: 'Statistik tiket berhasil dihitung.', data: { total: statusCounts.reduce((sum, [, count]) => sum + count, 0), byStatus: Object.fromEntries(statusCounts), byPriority: Object.fromEntries(priorityCounts) } };
}

async function listTickets(args: Args): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, Math.trunc(args.limit))) : 20;
  let query = supabase.from('tickets').select('id, subject, description, status, priority, assigned_to, created_at').order('created_at', { ascending: false }).limit(100);
  if (typeof args.status === 'string') query = query.eq('status', args.status);
  const { data, error } = await query;
  if (error) throw new Error('query_failed');

  const search = typeof args.query === 'string' ? args.query.trim().toLocaleLowerCase('id-ID') : '';
  const filtered = (data ?? []).filter((ticket: { subject: string; description: string }) => !search || `${ticket.subject} ${ticket.description}`.toLocaleLowerCase('id-ID').includes(search)).slice(0, limit);
  const safeTickets = filtered.map((ticket: { id: string; subject: string; description: string; status: string; priority: string; assigned_to: string | null; created_at: string }) => ({
    id: ticket.id,
    subject: maskPII(stripHtmlAndControls(ticket.subject)).slice(0, 300),
    description_excerpt: maskPII(stripHtmlAndControls(ticket.description)).slice(0, 280),
    status: ticket.status,
    priority: ticket.priority,
    assigned_to: ticket.assigned_to,
    created_at: ticket.created_at,
  }));
  return { ok: true, message: `${safeTickets.length} tiket ditemukan. Deskripsi ditampilkan sebagai kutipan singkat yang sudah disensor.`, data: { tickets: safeTickets, limit, appliedStatus: args.status ?? null } };
}

async function assignTicket(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const audit = await writeAuditLog({ actorId, action: 'admin.ticket.assign', resourceType: 'ticket', resourceId: String(args.ticket_id), metadata: { assigned_to: args.assigned_to } });
  if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Penugasan dibatalkan karena audit log tidak tersedia.' };
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('tickets').update({ assigned_to: args.assigned_to }).eq('id', args.ticket_id).select('id, status, assigned_to').maybeSingle();
  if (error) throw new Error('query_failed');
  if (!data) return { ok: false, code: 'not_found', message: 'Tiket tidak ditemukan.' };
  return { ok: true, message: 'Penugasan tiket berhasil diperbarui.', data };
}

async function closeTicket(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const audit = await writeAuditLog({ actorId, action: 'admin.ticket.close', resourceType: 'ticket', resourceId: String(args.ticket_id), metadata: { confirmed: true } });
  if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Penutupan tiket dibatalkan karena audit log tidak tersedia.' };
  const supabase = createSupabaseAdminClient();
  const { data: existing, error: readError } = await supabase.from('tickets').select('id, status').eq('id', args.ticket_id).maybeSingle();
  if (readError) throw new Error('query_failed');
  if (!existing) return { ok: false, code: 'not_found', message: 'Tiket tidak ditemukan.' };
  if (existing.status === 'closed') return { ok: true, message: 'Tiket tersebut sudah berstatus closed.', data: existing };
  const { data, error } = await supabase.from('tickets').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', args.ticket_id).select('id, status, closed_at').maybeSingle();
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'Tiket berhasil ditutup.', data: { ...data, reason: typeof args.reason === 'string' ? maskPII(stripHtmlAndControls(args.reason)).slice(0, 500) : null } };
}

async function getTopTopics(days: number): Promise<ToolExecutionResult> {
  const since = sinceDays(days);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('messages').select('content').eq('role', 'user').gte('created_at', since).order('created_at', { ascending: false }).limit(1000);
  if (error) throw new Error('query_failed');
  const topicPatterns: Array<[string, RegExp]> = [
    ['Pajak penghasilan / PPh', /\bpph\b|pajak penghasilan|withholding/i],
    ['PPN / faktur pajak', /\bppn\b|faktur pajak|pajak pertambahan nilai/i],
    ['SPT dan pelaporan', /\bspt\b|pelaporan pajak|lapor pajak/i],
    ['Pembukuan / laporan keuangan', /pembukuan|laporan keuangan|neraca|laba rugi/i],
    ['Biaya dan penawaran', /tarif|harga|biaya|penawaran|quotation/i],
    ['Konsultasi layanan', /konsultasi|layanan|jasa akuntansi|jasa pajak/i],
    ['Kontak dan jadwal', /kontak|alamat|nomor telepon|jam kerja|jadwal/i],
    ['Legal dan perusahaan', /legal|akta|izin usaha|profil perusahaan/i],
  ];
  const counts = new Map<string, number>(topicPatterns.map(([label]) => [label, 0]));
  for (const row of data ?? []) {
    const content = typeof row.content === 'string' ? row.content : '';
    for (const [label, pattern] of topicPatterns) if (pattern.test(content)) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const topics = [...counts.entries()].map(([topic, count]) => ({ topic, count })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count).slice(0, 8);
  return { ok: true, message: `Topik pesan dihitung untuk ${days} hari terakhir; pesan mentah tidak dikembalikan.`, data: { days, sampledUserMessages: data?.length ?? 0, topics } };
}

async function getTokenUsage(days: number): Promise<ToolExecutionResult> {
  const since = sinceDays(days);
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('token_usage').select('provider, model, input_tokens, output_tokens, estimated_cost_usd').gte('created_at', since).limit(5000);
  if (error) throw new Error('query_failed');
  const groups = new Map<string, { provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; storedCost: number }>();
  for (const row of data ?? []) {
    const key = `${row.provider}:${row.model}`;
    const item = groups.get(key) ?? { provider: row.provider, model: row.model, requests: 0, inputTokens: 0, outputTokens: 0, storedCost: 0 };
    item.requests += 1;
    item.inputTokens += countValue(row.input_tokens);
    item.outputTokens += countValue(row.output_tokens);
    item.storedCost += Number(row.estimated_cost_usd ?? 0);
    groups.set(key, item);
  }
  const pricesConfigured = ['GROQ_INPUT_PRICE_PER_MILLION', 'GROQ_OUTPUT_PRICE_PER_MILLION', 'GOOGLE_INPUT_PRICE_PER_MILLION', 'GOOGLE_OUTPUT_PRICE_PER_MILLION'].every((key) => process.env[key] !== undefined && process.env[key] !== '');
  const byProviderModel = [...groups.values()].map((item) => ({
    provider: item.provider,
    model: item.model,
    requests: item.requests,
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    estimatedCostUsd: pricesConfigured ? Math.round(item.storedCost * 100_000_000) / 100_000_000 : null,
  }));
  return { ok: true, message: 'Pemakaian token berhasil diringkas. Estimasi biaya hanya tersedia jika harga provider dikonfigurasi.', data: { days, requests: byProviderModel.reduce((sum, row) => sum + row.requests, 0), inputTokens: byProviderModel.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: byProviderModel.reduce((sum, row) => sum + row.outputTokens, 0), costEstimateConfigured: pricesConfigured, byProviderModel } };
}

async function getProviderStatus(): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('provider_status').select('provider, status, last_checked_at, latency_ms, last_error_code').order('provider');
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'Status provider berhasil diambil.', data: { providers: data ?? [] } };
}

async function switchModel(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const provider = args.provider === 'google' ? 'google' : 'groq';
  const model = provider === 'google' ? 'gemini-2.5-flash' : 'llama-3.3-70b-versatile';
  const audit = await writeAuditLog({ actorId, action: 'admin.model_switch', resourceType: 'llm_provider', resourceId: provider, metadata: { provider, model } });
  if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Perubahan model dibatalkan karena audit log tidak tersedia.' };

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase.from('agent_configs').upsert({
    agent_key: 'llm_provider',
    config: { provider, model },
    is_enabled: true,
    updated_by: actorId,
  }, { onConflict: 'agent_key' });
  if (error) throw new Error('query_failed');
  return { ok: true, message: `Provider utama diubah menjadi ${provider} (${model}). Request berikutnya mencoba provider ini terlebih dahulu dan tetap memiliki fallback.`, data: { provider, model } };
}

async function addFaq(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const title = maskPII(stripHtmlAndControls(String(args.title)));
  const content = maskPII(stripHtmlAndControls(String(args.content)));
  const embedding = await embedText(`${title}\n\n${content}`);
  const audit = await writeAuditLog({ actorId, action: 'admin.kb.add', resourceType: 'knowledge_base', metadata: { category: args.category, embeddingDimensions: embedding.length } });
  if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Penambahan FAQ dibatalkan karena audit log tidak tersedia.' };

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from('knowledge_base').insert({
    title,
    content,
    category: args.category,
    source_url: safeUrl(args.source_url),
    embedding,
    metadata: { created_via: 'admin_copilot', embedding_model: EMBEDDING_MODEL_ID },
    is_published: true,
    created_by: actorId,
  }).select('id, title, category, is_published, created_at').single();
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'FAQ berhasil ditambahkan dan embedding tersimpan.', data };
}

async function updateFaq(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const { data: existing, error: readError } = await supabase.from('knowledge_base').select('id, title, content, category, source_url').eq('id', args.id).maybeSingle();
  if (readError) throw new Error('query_failed');
  if (!existing) return { ok: false, code: 'not_found', message: 'FAQ tidak ditemukan.' };
  const title = typeof args.title === 'string' ? maskPII(stripHtmlAndControls(args.title)) : existing.title;
  const content = typeof args.content === 'string' ? maskPII(stripHtmlAndControls(args.content)) : existing.content;
  const category = typeof args.category === 'string' ? args.category : existing.category;
  const sourceUrlWasProvided = Object.prototype.hasOwnProperty.call(args, 'source_url');
  const sourceUrl = sourceUrlWasProvided ? safeUrl(args.source_url) : existing.source_url;
  const didChange = title !== existing.title || content !== existing.content || category !== existing.category || sourceUrl !== existing.source_url;
  if (!didChange) return { ok: false, code: 'invalid_arguments', message: 'Tidak ada perubahan yang diberikan.' };
  const updates: Record<string, unknown> = { title, content, category, source_url: sourceUrl };
  if (title !== existing.title || content !== existing.content) updates.embedding = await embedText(`${title}\n\n${content}`);
  const audit = await writeAuditLog({ actorId, action: 'admin.kb.update', resourceType: 'knowledge_base', resourceId: String(args.id), metadata: { category, embeddingRegenerated: 'embedding' in updates } });
  if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Pembaruan FAQ dibatalkan karena audit log tidak tersedia.' };
  const { data, error } = await supabase.from('knowledge_base').update(updates).eq('id', args.id).select('id, title, category, is_published, updated_at').single();
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'FAQ berhasil diperbarui.', data };
}

async function deleteFaq(args: Args): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const { data: existing, error: readError } = await supabase.from('knowledge_base').select('id, title').eq('id', args.id).maybeSingle();
  if (readError) throw new Error('query_failed');
  if (!existing) return { ok: false, code: 'not_found', message: 'FAQ tidak ditemukan.' };
  const { error } = await supabase.from('knowledge_base').delete().eq('id', args.id);
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'FAQ berhasil dihapus.', data: { id: existing.id, title: existing.title } };
}

async function sendBroadcast(args: Args, actorId: string): Promise<ToolExecutionResult> {
  const supabase = createSupabaseAdminClient();
  const title = stripHtmlAndControls(String(args.title));
  const message = stripHtmlAndControls(String(args.message));
  const { data, error } = await supabase.from('broadcast_queue').insert({
    created_by: actorId,
    title,
    message,
    audience: args.audience === 'active_30_days' ? 'active_30_days' : 'all',
    status: 'pending',
    confirmed_at: new Date().toISOString(),
    delivery_result: { queued_via: 'admin_copilot' },
  }).select('id, title, audience, status, created_at, confirmed_at').single();
  if (error) throw new Error('query_failed');
  return { ok: true, message: 'Pengumuman masuk antrean dengan status pending. Belum ada email, SMS, atau WhatsApp yang dikirim; integrasi delivery diperlukan.', data };
}

async function getUserActivity(days: number): Promise<ToolExecutionResult> {
  const since = sinceDays(days);
  const supabase = createSupabaseAdminClient();
  const [conversations, messages, tickets] = await Promise.all([
    supabase.from('conversations').select('created_at, user_id').gte('created_at', since).limit(5000),
    supabase.from('messages').select('created_at, role').gte('created_at', since).eq('role', 'user').limit(5000),
    supabase.from('tickets').select('created_at, user_id').gte('created_at', since).limit(5000),
  ]);
  if (conversations.error || messages.error || tickets.error) throw new Error('query_failed');
  const byDay = new Map<string, { day: string; conversations: number; userMessages: number; tickets: number; activeUsers: Set<string> }>();
  const getDay = (value: string) => value.slice(0, 10);
  const getBucket = (day: string) => {
    let item = byDay.get(day);
    if (!item) {
      item = { day, conversations: 0, userMessages: 0, tickets: 0, activeUsers: new Set<string>() };
      byDay.set(day, item);
    }
    return item;
  };
  for (const row of conversations.data ?? []) {
    const bucket = getBucket(getDay(row.created_at));
    bucket.conversations += 1;
    if (row.user_id) bucket.activeUsers.add(row.user_id);
  }
  for (const row of messages.data ?? []) getBucket(getDay(row.created_at)).userMessages += 1;
  for (const row of tickets.data ?? []) {
    const bucket = getBucket(getDay(row.created_at));
    bucket.tickets += 1;
    if (row.user_id) bucket.activeUsers.add(row.user_id);
  }
  const activity = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).map(({ activeUsers, ...row }) => ({ ...row, uniqueUsersWithConversationOrTicket: activeUsers.size }));
  return { ok: true, message: 'Aktivitas pengguna diringkas secara agregat; ID akun dan isi pesan tidak dikembalikan.', data: { days, activity } };
}

async function generateReport(days: number): Promise<ToolExecutionResult> {
  const [chat, ticket, token, topics] = await Promise.all([
    getChatStats(days),
    getTicketStats(),
    getTokenUsage(days),
    getTopTopics(days),
  ]);
  if (!chat.ok || !ticket.ok || !token.ok || !topics.ok) throw new Error('query_failed');
  return {
    ok: true,
    message: `Laporan operasional agregat untuk ${days} hari terakhir berhasil dibuat. Statistik status tiket mencakup seluruh tiket; data token dan percakapan mengikuti rentang hari.`,
    data: { generatedAt: new Date().toISOString(), periodDays: days, chat: chat.data, tickets: ticket.data, tokenUsage: token.data, topTopics: topics.data },
  };
}

/** Central allowlist + Zod validation + authenticated admin gate. Never accepts SQL or arbitrary table names. */
export async function executeAdminTool(name: AdminToolName, rawInput: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const definition = ADMIN_TOOL_DEFINITIONS[name];
  if (!definition) return { ok: false, code: 'invalid_arguments', message: 'Tool tidak diizinkan.' };
  const parsed = definition.schema.safeParse(rawInput);
  if (!parsed.success || !isRecord(parsed.data)) {
    return { ok: false, code: 'invalid_arguments', message: 'Parameter tool tidak valid atau tidak lengkap.' };
  }
  const args = parsed.data;

  let adminUserId: string;
  try {
    const gate = await requireAdmin();
    adminUserId = gate.user.id;
    if (adminUserId !== context.actorId) return { ok: false, code: 'unauthorized', message: 'Identitas admin tidak cocok dengan sesi aktif.' };
  } catch {
    return { ok: false, code: 'unauthorized', message: 'Akses admin diperlukan untuk menjalankan tool.' };
  }

  if (!(await auditTool(adminUserId, name, context.confirmed))) {
    return { ok: false, code: 'audit_unavailable', message: 'Tool dibatalkan karena audit log tidak dapat ditulis.' };
  }

  if ((definition as { destructive?: boolean }).destructive && !context.confirmed) {
    const supabase = createSupabaseAdminClient();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase.from('admin_pending_actions').insert({
      actor_id: adminUserId,
      tool_name: name,
      arguments: args,
      status: 'pending',
      expires_at: expiresAt,
    }).select('id, expires_at').single();
    if (error || !pending) {
      return { ok: false, code: 'operation_failed', message: 'Permintaan konfirmasi tidak dapat dibuat. Terapkan migration 002 dan coba lagi.' };
    }
    return {
      ok: false,
      code: 'confirmation_required',
      confirmationRequired: true,
      message: 'Tinjau kembali tindakan admin di bawah, lalu gunakan tombol konfirmasi yang terpisah. Token hanya berlaku lima menit dan hanya dapat digunakan satu kali. Belum ada perubahan yang dilakukan.',
      data: { confirmationId: pending.id, tool: name, expiresAt: pending.expires_at },
    };
  }

  if ((definition as { destructive?: boolean }).destructive && context.confirmed) {
    if (!context.confirmationId) {
      return { ok: false, code: 'confirmation_required', confirmationRequired: true, message: 'Konfirmasi ditolak karena token konfirmasi satu kali tidak disertakan. Buat permintaan konfirmasi baru.' };
    }
    const supabase = createSupabaseAdminClient();
    const { data: pending, error: pendingError } = await supabase
      .from('admin_pending_actions')
      .select('id, actor_id, tool_name, arguments, status, expires_at')
      .eq('id', context.confirmationId)
      .eq('actor_id', adminUserId)
      .eq('tool_name', name)
      .eq('status', 'pending')
      .maybeSingle();
    if (pendingError || !pending) {
      return { ok: false, code: 'invalid_arguments', message: 'Token konfirmasi tidak valid, sudah digunakan, atau bukan milik admin yang sedang login.' };
    }
    if (Date.parse(pending.expires_at) <= Date.now()) {
      await supabase.from('admin_pending_actions').update({ status: 'expired' }).eq('id', context.confirmationId).eq('status', 'pending');
      return { ok: false, code: 'invalid_arguments', message: 'Token konfirmasi telah kedaluwarsa. Ulangi permintaan untuk membuat konfirmasi baru.' };
    }
    const stable = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
      if (isRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
      return JSON.stringify(value);
    };
    if (stable(pending.arguments) !== stable(args)) {
      return { ok: false, code: 'invalid_arguments', message: 'Parameter tindakan tidak sama dengan permintaan yang dikonfirmasi.' };
    }
    const { data: claimed, error: claimError } = await supabase.from('admin_pending_actions').update({ status: 'confirmed', confirmed_at: new Date().toISOString(), consumed_at: new Date().toISOString() }).eq('id', context.confirmationId).eq('status', 'pending').select('id').maybeSingle();
    if (claimError || !claimed) {
      return { ok: false, code: 'invalid_arguments', message: 'Token konfirmasi telah digunakan atau tidak dapat dikunci.' };
    }
  }

  try {
    switch (name) {
      case 'get_chat_stats': return await getChatStats(Number(args.days));
      case 'get_ticket_stats': return await getTicketStats();
      case 'list_tickets': return await listTickets(args);
      case 'assign_ticket': return await assignTicket(args, adminUserId);
      case 'close_ticket': return await closeTicket(args, adminUserId);
      case 'get_top_topics': return await getTopTopics(Number(args.days));
      case 'get_token_usage': return await getTokenUsage(Number(args.days));
      case 'get_provider_status': return await getProviderStatus();
      case 'switch_model': return await switchModel(args, adminUserId);
      case 'add_faq': return await addFaq(args, adminUserId);
      case 'update_faq': return await updateFaq(args, adminUserId);
      case 'delete_faq': {
        const audit = await writeAuditLog({ actorId: adminUserId, action: 'admin.kb.delete', resourceType: 'knowledge_base', resourceId: String(args.id), metadata: { confirmed: true } });
        if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Penghapusan FAQ dibatalkan karena audit log tidak tersedia.' };
        return await deleteFaq(args);
      }
      case 'send_broadcast': {
        const audit = await writeAuditLog({ actorId: adminUserId, action: 'admin.broadcast.enqueue', resourceType: 'broadcast_queue', metadata: { confirmed: true, audience: args.audience } });
        if (!audit.ok) return { ok: false, code: 'audit_unavailable', message: 'Broadcast dibatalkan karena audit log tidak tersedia.' };
        return await sendBroadcast(args, adminUserId);
      }
      case 'get_user_activity': return await getUserActivity(Number(args.days));
      case 'generate_report': return await generateReport(Number(args.days));
      default: return { ok: false, code: 'invalid_arguments', message: 'Tool tidak diizinkan.' };
    }
  } catch (error) {
    // Log an opaque event only; never surface raw SQL/provider/database exceptions to the model or browser.
    console.error(JSON.stringify({ event: 'admin_tool_execution_failed', tool: name, code: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }));
    return { ok: false, code: 'operation_failed', message: 'Tool gagal dijalankan. Periksa status database dan audit log, lalu coba lagi.' };
  }
}

/** Execute a previously staged destructive action from its one-time confirmation ID. */
export async function executePendingAdminAction(confirmationId: string, actorId: string): Promise<ToolExecutionResult & { tool?: AdminToolName }> {
  try {
    const gate = await requireAdmin();
    if (gate.user.id !== actorId) return { ok: false, code: 'unauthorized', message: 'Identitas admin tidak cocok dengan sesi aktif.' };
    const supabase = createSupabaseAdminClient();
    const { data: pending, error } = await supabase
      .from('admin_pending_actions')
      .select('actor_id, tool_name, arguments, status, expires_at')
      .eq('id', confirmationId)
      .eq('actor_id', actorId)
      .eq('status', 'pending')
      .maybeSingle();
    if (error || !pending || !isAdminToolName(String(pending.tool_name)) || !(ADMIN_TOOL_DEFINITIONS[pending.tool_name as AdminToolName] as { destructive?: boolean }).destructive) {
      return { ok: false, code: 'invalid_arguments', message: 'Permintaan konfirmasi tidak ditemukan, bukan milik sesi ini, atau sudah dipakai.' };
    }
    if (Date.parse(pending.expires_at) <= Date.now()) {
      await supabase.from('admin_pending_actions').update({ status: 'expired' }).eq('id', confirmationId).eq('status', 'pending');
      return { ok: false, code: 'invalid_arguments', message: 'Konfirmasi telah kedaluwarsa. Ajukan ulang tindakan tersebut.' };
    }
    const tool = pending.tool_name as AdminToolName;
    const result = await executeAdminTool(tool, pending.arguments, { actorId, confirmed: true, confirmationId });
    return { ...result, tool };
  } catch {
    return { ok: false, code: 'operation_failed', message: 'Konfirmasi tidak dapat diproses. Coba ulangi tindakan melalui Admin Copilot.' };
  }
}

export function isAdminToolName(value: string): value is AdminToolName {
  return Object.prototype.hasOwnProperty.call(ADMIN_TOOL_DEFINITIONS, value);
}
