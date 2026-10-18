# Tahap 2 — RAG Pipeline, LLM, Agent Logic, dan Admin Tools

Tahap ini menambahkan logika server-side untuk menjawab chat publik dengan RAG dan menjalankan 15 tool Admin Copilot melalui allowlist. API routes, UI, widget embed, seeding 48 chunk, dan dokumentasi skripsi tetap berada di tahap berikutnya.

## Komponen

- `lib/rag/embed.ts`: Google Embedding dengan output 768 dimensi, divalidasi sebelum dipakai.
- `lib/rag/retrieve.ts`: RPC ke `match_knowledge_base`, maksimal 10 hasil, filter kategori terbatas, dan URL sumber HTTP(S) saja.
- `lib/rag/prompt-builder.ts`: konteks retrieval ditempatkan sebagai data tidak tepercaya, bukan instruksi; PII email/nomor HP dimasking sebelum dikirim ke LLM.
- `lib/llm/providers.ts`: pemanggilan REST server-side ke Groq dan Google, timeout 25 detik, error provider tidak diteruskan mentah.
- `lib/llm/client.ts`: Groq utama, Gemini fallback, pembacaan konfigurasi model dari `agent_configs`, daftar model allowlist, dan health status.
- `lib/llm/usage-tracker.ts`: mencatat token, model, provider, request ID, dan estimasi biaya bila harga per juta token dikonfigurasi.
- `lib/agents/router.ts`, `user-agents.ts`: router deterministik lalu agent FAQ, layanan, dan eskalasi.
- `lib/agents/admin-agents.ts`: Orchestrator hanya boleh memilih tool dalam katalog, maksimal satu per turn.
- `lib/tools/definitions.ts`, `registry.ts`: 15 tool dengan skema Zod, pemeriksaan admin server-side, audit, serta gerbang konfirmasi aksi destruktif yang terikat ke admin dan parameter tindakan.
- `supabase/migrations/002_broadcast_queue.sql`: antrean outbox broadcast yang aman. Tidak mengirim email/SMS/WhatsApp tanpa integrasi provider delivery.

## Setup tambahan

1. Pastikan Tahap 1 dan migration `001_init.sql` telah diterapkan pada proyek Supabase baru khusus chatbot.
2. Terapkan `supabase/migrations/002_broadcast_queue.sql` setelah migration pertama.
3. Tambahkan `GOOGLE_EMBEDDING_MODEL=gemini-embedding-2` ke environment deployment; jangan gunakan model embedding yang berbeda pada koleksi vector yang sama.
4. Setelah menambahkan file, jalankan `npm install`, `npm run typecheck`, lalu `npm run build` di lingkungan yang memiliki akses package registry.

## Catatan penting tentang embedding

Google mencatat `text-embedding-004` ditutup pada **14 Januari 2026**. Implementasi tahap ini menggunakan `gemini-embedding-2` dengan `output_dimensionality=768`, cocok dengan `vector(768)` dalam migration 001. Namun, walau dimensinya sama, embedding dari model berbeda tidak berada dalam ruang vektor yang bisa langsung dibandingkan secara andal. Karena itu, sebelum membuka RAG ke pengguna, seluruh 48 chunk knowledge base yang lama harus di-embed ulang memakai model yang sama. Jangan mencampur vektor lama dan baru. Script `scripts/re-embed.ts` / `scripts/seed-kb.ts` akan dibuat pada Tahap 4.

## Catatan batas produksi

- `send_broadcast` memasukkan pengumuman ke `broadcast_queue` dengan status `pending`; pengiriman belum terjadi. Diperlukan worker dan integrasi delivery pada tahap selanjutnya.
- `close_ticket`, `delete_faq`, dan `send_broadcast` membuat tiket konfirmasi satu kali yang terikat ke actor + nama tool + parameter, kedaluwarsa dalam 5 menit, dan hanya dapat dipakai sekali. API Tahap 3 harus mengirim kembali `{ confirmation: { confirmationId, confirmed: true } }` hanya ketika admin mengklik tombol konfirmasi terpisah. Nilai `confirmed` dari argumen model diabaikan.
- Tidak ada tool SQL mentah. Semua query berasal dari kode yang di-allowlist dan menggunakan Supabase client.
- Deteksi prompt injection bukan pertahanan sempurna. RLS, autentikasi admin, validasi schema, allowlist tool, pembatasan data yang dikembalikan, dan audit tetap wajib.
- Penggunaan provider tidak dapat dijamin gratis selamanya; free tier, kuota, dan model yang tersedia ditetapkan penyedia dan dapat berubah.

## Verifikasi

Pemeriksaan TypeScript/production build belum dapat dinyatakan lulus bila dependensi belum diinstal dan project belum memakai kredensial staging. Jalankan typecheck/build dan uji seluruh jalur di proyek Supabase staging sebelum deploy.
