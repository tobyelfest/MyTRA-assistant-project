# Chatbot MyTRA — Tahap 1: Foundation & Security

## Scope

This stage includes environment validation, baseline security utilities, Supabase browser/server/admin clients, user-scoped queries, and `supabase/migrations/001_init.sql`. No RAG pipeline, agent logic, API routes, widget, or dashboard implementation is included.

## Setup

1. Use Node.js 20.11+.
2. Copy `.env.example` to `.env.local` and fill values from your own provider accounts. Do not commit `.env.local`.
3. In a NEW Supabase project, run `supabase/migrations/001_init.sql` in the SQL Editor or with Supabase CLI.
4. Set Vercel environment variables for Preview and Production independently.
5. Install and verify:
   ```bash
   npm install
   npm run typecheck
   npm run build
   ```

## Important security notes

- `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS. It belongs only in server-side modules and must never be sent to the browser.
- The database migration intentionally denies direct browser access to public knowledge-base chunks; public RAG requests should be handled by a server route and the service-role client after validation/rate limiting.
- `requireAdmin()` checks the current Supabase-authenticated user against the `profiles.role` value. Do not trust a role sent in request JSON, local storage, a JWT custom claim you don't control, or UI state.
- `sanitizeChatInput()` and `detectPromptInjection()` are heuristic filters. They do not make prompt injection impossible. Keep retrieval context untrusted, do not allow LLM-generated SQL, authorize each tool server-side, and require explicit server-validated confirmation for destructive operations.
- The rate limiter fails closed if its required environment is invalid, but a Redis network outage will throw; API routes in Stage 3 must return a controlled `503`, not silently skip limits. Trust forwarded-IP headers only behind the intended platform/proxy.
- The current `match_knowledge_base()` function is executable only by `service_role`; do not loosen this grant to `anon` or `authenticated` without reviewing data exposure.
- Apply the migration first to a disposable/staging Supabase project and run authorization tests with at least one normal user and one admin before production.

## Free-tier expectations

This design avoids a self-managed VPS but does not guarantee permanently zero cost or unlimited usage. Vercel, Supabase, Groq, Google AI Studio, and Upstash quotas and policies can change; add usage alerts and verify current plan limits before deployment.

## Generate local secrets

Generate two independent values; do not reuse one key for both purposes:

```bash
node -e "console.log('JWT_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ENCRYPTION_KEY=' + require('node:crypto').randomBytes(32).toString('hex'))"
```

## Bootstrap the first administrator

Create the account through Supabase Auth first, confirm the profile exists, then promote the intended account manually through the Supabase SQL Editor or a trusted server-only administrative script. Never expose a public endpoint for changing `profiles.role` and never allow the AI tool layer to write that column.

```sql
-- Replace the email with the intended administrator account before running.
update public.profiles p
set role = 'admin'
from auth.users u
where p.id = u.id and u.email = 'ADMIN_EMAIL_TO_REPLACE';
```

This is an operator-only one-time bootstrap operation, not part of the application API.

## Deployment caveats that must be resolved before production

- **Vercel Hobby is not suitable for the real commercial deployment of a company service.** Vercel documents Hobby as personal/non-commercial use only. For a service used by PT KJA MyTRA, choose a plan that permits commercial use or choose a host whose terms permit this deployment. A student prototype that is genuinely personal/non-commercial is a different use case; do not relabel the company's production service as personal use. See: https://vercel.com/docs/plans/hobby and https://vercel.com/docs/limits/fair-use-guidelines.
- **Next.js 14 is listed as unsupported in the official support policy.** This stage pins `14.2.35`, which is the v14 patch named by the December 11, 2025 security update; this does not restore the branch to supported status. Before a real production launch, schedule a supported Next.js major-version migration and regression test. See: https://nextjs.org/support-policy and https://nextjs.org/blog/security-update-2025-12-11.
- “Zero cost” is not a durable service-level guarantee: free quotas, eligible use cases, provider model availability, and limits can change. Confirm provider terms and quotas at deployment time and design a graceful degraded mode for exhausted quota or provider outages.
