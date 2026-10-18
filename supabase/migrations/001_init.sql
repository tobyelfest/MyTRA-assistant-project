-- Chatbot MyTRA — initial schema, grants, and RLS policies.
-- Apply to a NEW Supabase project. Review policies in staging before production.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

grant usage on schema public, extensions to authenticated, service_role;

-- Profiles: role changes are reserved to trusted server-side administration.
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 160),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_base (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 300),
  content text not null check (char_length(content) between 1 and 30000),
  category text not null check (category in ('layanan', 'perusahaan', 'kontak', 'legal', 'event')),
  source_url text check (source_url is null or char_length(source_url) <= 2048),
  embedding extensions.vector(768),
  metadata jsonb not null default '{}'::jsonb,
  is_published boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  title text not null default 'Percakapan baru' check (char_length(title) <= 300),
  status text not null default 'open' check (status in ('open', 'closed', 'archived')),
  channel text not null default 'web' check (channel in ('web', 'widget', 'admin')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'assistant', 'admin', 'system', 'tool')),
  content text not null check (char_length(content) <= 30000),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null default auth.uid(),
  conversation_id uuid references public.conversations(id) on delete set null,
  subject text not null check (char_length(subject) between 1 and 300),
  description text not null check (char_length(description) between 1 and 12000),
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists public.token_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider text not null check (provider in ('groq', 'google', 'system')),
  model text not null check (char_length(model) <= 160),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  total_tokens integer generated always as (input_tokens + output_tokens) stored,
  estimated_cost_usd numeric(12, 8) not null default 0 check (estimated_cost_usd >= 0),
  request_id text check (request_id is null or char_length(request_id) <= 200),
  created_at timestamptz not null default now()
);

create table if not exists public.agent_configs (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null unique check (char_length(agent_key) between 1 and 100),
  config jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (char_length(action) between 1 and 160),
  resource_type text check (resource_type is null or char_length(resource_type) <= 100),
  resource_id text check (resource_id is null or char_length(resource_id) <= 200),
  ip_hash text check (ip_hash is null or char_length(ip_hash) = 64),
  user_agent text check (user_agent is null or char_length(user_agent) <= 400),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.provider_status (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('groq', 'google')),
  status text not null default 'unknown' check (status in ('healthy', 'degraded', 'down', 'unknown')),
  last_checked_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  updated_at timestamptz not null default now()
);

-- Indexes for common filters and retrieval.
create index if not exists idx_kb_category_published on public.knowledge_base(category, is_published);
create index if not exists idx_kb_embedding_hnsw on public.knowledge_base using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;
create index if not exists idx_conversations_user_updated on public.conversations(user_id, updated_at desc);
create index if not exists idx_messages_conversation_created on public.messages(conversation_id, created_at asc);
create index if not exists idx_tickets_user_created on public.tickets(user_id, created_at desc);
create index if not exists idx_tickets_status_priority on public.tickets(status, priority, created_at desc);
create index if not exists idx_token_usage_user_created on public.token_usage(user_id, created_at desc);
create index if not exists idx_audit_logs_actor_created on public.audit_logs(actor_id, created_at desc);
create index if not exists idx_audit_logs_action_created on public.audit_logs(action, created_at desc);

-- Keep updated_at accurate. Do not update immutable created_at fields.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists trg_knowledge_base_updated_at on public.knowledge_base;
create trigger trg_knowledge_base_updated_at before update on public.knowledge_base for each row execute function public.set_updated_at();
drop trigger if exists trg_conversations_updated_at on public.conversations;
create trigger trg_conversations_updated_at before update on public.conversations for each row execute function public.set_updated_at();
drop trigger if exists trg_tickets_updated_at on public.tickets;
create trigger trg_tickets_updated_at before update on public.tickets for each row execute function public.set_updated_at();
drop trigger if exists trg_agent_configs_updated_at on public.agent_configs;
create trigger trg_agent_configs_updated_at before update on public.agent_configs for each row execute function public.set_updated_at();
drop trigger if exists trg_provider_status_updated_at on public.provider_status;
create trigger trg_provider_status_updated_at before update on public.provider_status for each row execute function public.set_updated_at();

-- Helper used by policies. SECURITY DEFINER avoids recursive RLS evaluation on profiles.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- Vector search is server-only (service_role), never executable by anon/authenticated.
create or replace function public.match_knowledge_base(
  query_embedding extensions.vector(768),
  match_threshold double precision default 0.25,
  match_count integer default 5,
  filter_category text default null
)
returns table (
  id uuid,
  title text,
  content text,
  category text,
  source_url text,
  similarity double precision
)
language sql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
  select
    kb.id,
    kb.title,
    kb.content,
    kb.category,
    kb.source_url,
    (1 - (kb.embedding <=> query_embedding))::double precision as similarity
  from public.knowledge_base kb
  where kb.is_published = true
    and kb.embedding is not null
    and (filter_category is null or kb.category = filter_category)
    and (1 - (kb.embedding <=> query_embedding)) >= match_threshold
  order by kb.embedding <=> query_embedding asc
  limit least(greatest(coalesce(match_count, 5), 1), 20);
$$;

revoke all on function public.match_knowledge_base(extensions.vector, double precision, integer, text) from public, anon, authenticated;
grant execute on function public.match_knowledge_base(extensions.vector, double precision, integer, text) to service_role;

-- Enable RLS on every application table.
alter table public.profiles enable row level security;
alter table public.knowledge_base enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.tickets enable row level security;
alter table public.token_usage enable row level security;
alter table public.agent_configs enable row level security;
alter table public.audit_logs enable row level security;
alter table public.provider_status enable row level security;

-- Remove ambient grants, then grant only what browser users need. service_role is used server-side.
revoke all on public.profiles, public.knowledge_base, public.conversations, public.messages,
  public.tickets, public.token_usage, public.agent_configs, public.audit_logs, public.provider_status
from anon, authenticated;

grant select (id, full_name, avatar_url, role, created_at, updated_at) on public.profiles to authenticated;
grant insert (id, full_name, avatar_url) on public.profiles to authenticated;
grant update (full_name, avatar_url) on public.profiles to authenticated;

grant select on public.conversations to authenticated;
grant insert (user_id, title, metadata) on public.conversations to authenticated;
grant update (title) on public.conversations to authenticated;

grant select on public.messages to authenticated;
grant insert (conversation_id, content, metadata) on public.messages to authenticated;

grant select on public.tickets to authenticated;
grant insert (conversation_id, subject, description, priority) on public.tickets to authenticated;

grant select on public.token_usage to authenticated;
-- Other tables remain inaccessible to anon/authenticated; trusted server calls use service_role.
grant all on public.profiles, public.knowledge_base, public.conversations, public.messages,
  public.tickets, public.token_usage, public.agent_configs, public.audit_logs, public.provider_status
 to service_role;

-- Profiles: users can see and edit only safe columns on their own profile; admins can view all.
drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert to authenticated
with check (id = (select auth.uid()) and role = 'user');
drop policy if exists profiles_update_self_or_admin on public.profiles;
create policy profiles_update_self_or_admin on public.profiles for update to authenticated
using (id = (select auth.uid()) or (select public.is_admin()))
with check (id = (select auth.uid()) or (select public.is_admin()));

-- Knowledge base: never expose unpublished/internal chunks directly to browser users.
drop policy if exists knowledge_base_admin_all on public.knowledge_base;
create policy knowledge_base_admin_all on public.knowledge_base for all to authenticated
using ((select public.is_admin())) with check ((select public.is_admin()));

-- Conversations: authenticated users own their rows, administrators can operate all.
drop policy if exists conversations_select_own_or_admin on public.conversations;
create policy conversations_select_own_or_admin on public.conversations for select to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists conversations_insert_own on public.conversations;
create policy conversations_insert_own on public.conversations for insert to authenticated
with check (user_id = (select auth.uid()));
drop policy if exists conversations_update_own_or_admin on public.conversations;
create policy conversations_update_own_or_admin on public.conversations for update to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()))
with check (user_id = (select auth.uid()) or (select public.is_admin()));

-- A message is visible only when its parent conversation belongs to the user, or the actor is admin.
drop policy if exists messages_select_own_or_admin on public.messages;
create policy messages_select_own_or_admin on public.messages for select to authenticated
using (exists (select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = (select auth.uid()))
       or (select public.is_admin()));
drop policy if exists messages_insert_own_user on public.messages;
create policy messages_insert_own_user on public.messages for insert to authenticated
with check (role = 'user' and exists (
  select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = (select auth.uid())
));

-- Ticket owners can create tickets and read their own tickets. Status, assignment, and closure are server/admin only.
drop policy if exists tickets_select_own_or_admin on public.tickets;
create policy tickets_select_own_or_admin on public.tickets for select to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists tickets_insert_own on public.tickets;
create policy tickets_insert_own on public.tickets for insert to authenticated
with check (user_id = (select auth.uid()) and status = 'open' and assigned_to is null);

-- Usage rows are visible to their owner and admins; writes only via trusted server.
drop policy if exists token_usage_select_own_or_admin on public.token_usage;
create policy token_usage_select_own_or_admin on public.token_usage for select to authenticated
using (user_id = (select auth.uid()) or (select public.is_admin()));

-- Admin-only operational tables.
drop policy if exists agent_configs_admin_all on public.agent_configs;
create policy agent_configs_admin_all on public.agent_configs for all to authenticated
using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists audit_logs_admin_select on public.audit_logs;
create policy audit_logs_admin_select on public.audit_logs for select to authenticated
using ((select public.is_admin()));
drop policy if exists provider_status_admin_all on public.provider_status;
create policy provider_status_admin_all on public.provider_status for all to authenticated
using ((select public.is_admin())) with check ((select public.is_admin()));

-- Safe default privileges for future tables in public schema created by postgres migrations.
-- Review Supabase API exposed schemas and role grants whenever adding tables/views/functions.
