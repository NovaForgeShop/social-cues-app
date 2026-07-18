create table if not exists public.password_recovery_instances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null unique,
  status text not null default 'claimed'
    check (status in ('claimed', 'consumed', 'failed')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists password_recovery_instances_user_created_idx
  on public.password_recovery_instances (user_id, created_at desc);

alter table public.password_recovery_instances enable row level security;
revoke all on table public.password_recovery_instances from public, anon, authenticated;
grant select, insert, update, delete on table public.password_recovery_instances to service_role;

drop policy if exists password_recovery_instances_deny_client_access on public.password_recovery_instances;
create policy password_recovery_instances_deny_client_access
  on public.password_recovery_instances
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.password_recovery_instances is
  'Server-only replay protection for emailed Supabase password recovery sessions.';
