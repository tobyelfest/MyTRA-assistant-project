# Chatbot MyTRA — Dual-Role Multi-Agent

Fondasi project Next.js 14 App Router + TypeScript untuk chatbot publik berbasis RAG dan Admin Copilot dengan akses tool yang dibatasi.

## Status tahap

- **Tahap 1 — Foundation & Security:** konfigurasi proyek, environment, migration awal, Supabase clients/queries, sanitasi, rate-limit, dan audit log.
- **Tahap 2 — RAG & Agent Logic:** embedding/retrieval, provider Groq dan Google dengan fallback, token usage tracker, public FAQ/Layanan/Eskalasi agents, Admin Copilot orchestrator, 15 tool allowlist, dan confirmation ticket sekali pakai.
- **Tahap 3:** API routes dan UI belum dibuat.
- **Tahap 4:** public widget, seeding/re-embedding 48 chunk, dokumentasi deployment/API/skripsi belum dibuat.

## Setup lokal

1. Salin `.env.example` menjadi `.env.local` dan isi rahasia dari dashboard provider.
2. Terapkan `supabase/migrations/001_init.sql`, kemudian `supabase/migrations/002_broadcast_queue.sql` pada proyek Supabase baru khusus chatbot.
3. Jalankan `npm install`, `npm run typecheck`, `npm run build`.
4. Uji di proyek Supabase staging sebelum deploy.

## Catatan model embedding

`text-embedding-004` ditutup oleh Google pada 14 Januari 2026. Tahap 2 menggunakan `gemini-embedding-2` berdimensi 768 agar sesuai `vector(768)`. Jangan membuka RAG ke publik hingga seluruh 48 chunk lama di-embed ulang menggunakan model yang sama. Script re-embed dibuat pada Tahap 4.

## Batas yang diketahui

`send_broadcast` saat ini hanya menaruh pesan ke antrean `pending`; belum mengirim email/SMS/WhatsApp. Integrasi delivery dan worker diperlukan. Free tier provider dapat berubah dan tidak menjamin biaya selalu nol. Next.js 14 dan paket hosting yang tidak mengizinkan penggunaan komersial perlu ditinjau sebelum produksi perusahaan.
