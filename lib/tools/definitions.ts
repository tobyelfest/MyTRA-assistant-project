import 'server-only';
import { z } from 'zod';
import { KNOWLEDGE_CATEGORIES } from '@/lib/rag/retrieve';

const ticketStatus = z.enum(['open', 'in_progress', 'waiting_user', 'resolved', 'closed']);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const category = z.enum(KNOWLEDGE_CATEGORIES);
const days = z.number().int().min(1).max(90).default(7);
const ticketId = z.string().uuid();
const knowledgeId = z.string().uuid();

export type JsonSchema = Record<string, unknown>;
interface Definition {
  description: string;
  schema: z.ZodTypeAny;
  parameters: JsonSchema;
  destructive?: boolean;
}

const noArgs = z.object({}).strict();
const noArgsSchema: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

export const ADMIN_TOOL_DEFINITIONS = {
  get_chat_stats: {
    description: 'Ambil statistik percakapan dan pesan agregat untuk sejumlah hari terakhir.',
    schema: z.object({ days }),
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }, additionalProperties: false },
  },
  get_ticket_stats: {
    description: 'Ambil statistik tiket berdasarkan status dan prioritas.',
    schema: noArgs,
    parameters: noArgsSchema,
  },
  list_tickets: {
    description: 'Daftar tiket terbaru secara terbatas; hanya untuk kebutuhan operasional admin.',
    schema: z.object({ status: ticketStatus.optional(), limit: z.number().int().min(1).max(50).default(20), query: z.string().trim().max(80).optional() }),
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'in_progress', 'waiting_user', 'resolved', 'closed'] }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, query: { type: 'string', maxLength: 80 } }, additionalProperties: false },
  },
  assign_ticket: {
    description: 'Tugaskan tiket ke profil admin dengan UUID yang diketahui, atau kosongkan penugasan dengan null.',
    schema: z.object({ ticket_id: ticketId, assigned_to: z.string().uuid().nullable() }),
    parameters: { type: 'object', properties: { ticket_id: { type: 'string', format: 'uuid' }, assigned_to: { type: ['string', 'null'], format: 'uuid' } }, required: ['ticket_id', 'assigned_to'], additionalProperties: false },
  },
  close_ticket: {
    description: 'Tutup tiket. Selalu membutuhkan konfirmasi terpisah dari admin pada permintaan kedua.',
    schema: z.object({ ticket_id: ticketId, reason: z.string().trim().max(500).optional() }),
    parameters: { type: 'object', properties: { ticket_id: { type: 'string', format: 'uuid' }, reason: { type: 'string', maxLength: 500 } }, required: ['ticket_id'], additionalProperties: false },
    destructive: true,
  },
  get_top_topics: {
    description: 'Hitung topik teratas dari pesan pengguna berdasarkan kata kunci; tidak mengembalikan isi pesan mentah.',
    schema: z.object({ days }),
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }, additionalProperties: false },
  },
  get_token_usage: {
    description: 'Ambil agregat token input/output berdasarkan provider dan model untuk periode yang dipilih.',
    schema: z.object({ days }),
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }, additionalProperties: false },
  },
  get_provider_status: {
    description: 'Lihat status kesehatan provider model yang terakhir tercatat.',
    schema: noArgs,
    parameters: noArgsSchema,
  },
  switch_model: {
    description: 'Ganti provider/model utama untuk request berikutnya. Provider yang valid: groq atau google. Perubahan dicatat ke audit log.',
    schema: z.object({ provider: z.enum(['groq', 'google']) }),
    parameters: { type: 'object', properties: { provider: { type: 'string', enum: ['groq', 'google'] } }, required: ['provider'], additionalProperties: false },
  },
  add_faq: {
    description: 'Tambah entri knowledge base/FAQ baru dan membuat embedding untuk vector search.',
    schema: z.object({ title: z.string().trim().min(1).max(300), content: z.string().trim().min(1).max(12_000), category, source_url: z.string().url().max(2048).nullable().optional() }),
    parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 300 }, content: { type: 'string', minLength: 1, maxLength: 12000 }, category: { type: 'string', enum: [...KNOWLEDGE_CATEGORIES] }, source_url: { type: ['string', 'null'], format: 'uri', maxLength: 2048 } }, required: ['title', 'content', 'category'], additionalProperties: false },
  },
  update_faq: {
    description: 'Perbarui bidang entri knowledge base tertentu. Membuat ulang embedding jika judul atau konten berubah.',
    schema: z.object({ id: knowledgeId, title: z.string().trim().min(1).max(300).optional(), content: z.string().trim().min(1).max(12_000).optional(), category: category.optional(), source_url: z.string().url().max(2048).nullable().optional() }),
    parameters: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, title: { type: 'string', minLength: 1, maxLength: 300 }, content: { type: 'string', minLength: 1, maxLength: 12000 }, category: { type: 'string', enum: [...KNOWLEDGE_CATEGORIES] }, source_url: { type: ['string', 'null'], format: 'uri', maxLength: 2048 } }, required: ['id'], additionalProperties: false },
  },
  delete_faq: {
    description: 'Hapus entri knowledge base. Selalu membutuhkan konfirmasi terpisah dari admin pada permintaan kedua.',
    schema: z.object({ id: knowledgeId }),
    parameters: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false },
    destructive: true,
  },
  send_broadcast: {
    description: 'Setelah konfirmasi admin, masukkan pengumuman ke antrean broadcast. Pengiriman eksternal belum aktif sampai integrasi delivery dipasang.',
    schema: z.object({ title: z.string().trim().min(1).max(180), message: z.string().trim().min(1).max(4000), audience: z.enum(['all', 'active_30_days']).default('all') }),
    parameters: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 180 }, message: { type: 'string', minLength: 1, maxLength: 4000 }, audience: { type: 'string', enum: ['all', 'active_30_days'], default: 'all' } }, required: ['title', 'message'], additionalProperties: false },
    destructive: true,
  },
  get_user_activity: {
    description: 'Agregat aktivitas pengguna berdasarkan hari dan tipe kejadian tanpa mengirim email, nomor telepon, atau isi percakapan.',
    schema: z.object({ days }),
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }, additionalProperties: false },
  },
  generate_report: {
    description: 'Buat ringkasan laporan operasional agregat untuk periode yang ditentukan.',
    schema: z.object({ days }),
    parameters: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, default: 7 } }, additionalProperties: false },
  },
} satisfies Record<string, Definition>;

export type AdminToolName = keyof typeof ADMIN_TOOL_DEFINITIONS;
export type AdminToolArguments<T extends AdminToolName> = z.infer<(typeof ADMIN_TOOL_DEFINITIONS)[T]['schema']>;
