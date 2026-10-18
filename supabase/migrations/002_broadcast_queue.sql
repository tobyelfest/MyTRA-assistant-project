-- Stage 2 dependency: secure outbox for admin broadcast requests.
-- This queues an announcement; it does not deliver email, SMS, or WhatsApp by itself.

create table if not exists public.broadcast_queue (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references public.profiles(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 180),
  message text not null check (char_length(message) between 1 and 4000),
  audience text not null default 'all' check (audience in ('all', 'active_30_days')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  confirmed_at timestamptz not null,
  delivery_provider text,
  delivery_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_broadcast_queue_status_created
  on public.broadcast_queue(status, created_at desc);

alter table public.broadcast_queue enable row level security;
revoke all on public.broadcast_queue from public, anon, authenticated;
grant select on public.broadcast_queue to authenticated;
grant all on public.broadcast_queue to service_role;

drop policy if exists broadcast_queue_admin_select on public.broadcast_queue;
create policy broadcast_queue_admin_select on public.broadcast_queue
  for select to authenticated
  using ((select public.is_admin()));

drop trigger if exists trg_broadcast_queue_updated_at on public.broadcast_queue;
create trigger trg_broadcast_queue_updated_at before update on public.broadcast_queue
  for each row execute function public.set_updated_at();

-- One-time, actor-bound confirmation tickets for destructive Admin Copilot tools.
create table if not exists public.admin_pending_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  tool_name text not null check (tool_name in ('close_ticket', 'delete_faq', 'send_broadcast')),
  arguments jsonb not null check (jsonb_typeof(arguments) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'expired', 'failed')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_pending_actions_actor_status
  on public.admin_pending_actions(actor_id, status, expires_at desc);

alter table public.admin_pending_actions enable row level security;
revoke all on public.admin_pending_actions from public, anon, authenticated;
grant select on public.admin_pending_actions to authenticated;
grant all on public.admin_pending_actions to service_role;

drop policy if exists admin_pending_actions_admin_select on public.admin_pending_actions;
create policy admin_pending_actions_admin_select on public.admin_pending_actions
  for select to authenticated
  using ((select public.is_admin()) and actor_id = auth.uid());
