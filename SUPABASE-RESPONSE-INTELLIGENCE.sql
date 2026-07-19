-- Social Cues durable response, intelligence, metering, and device delivery layer.
-- All writes are server-owned. Customer access remains behind authenticated API routes.

create extension if not exists pgcrypto;

create table if not exists public.response_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  provider text not null,
  platform text not null,
  provider_event_id text not null,
  conversation_id text,
  parent_event_id text,
  event_type text not null,
  author_id text,
  author_name text,
  author_handle text,
  body_text text,
  media jsonb not null default '[]'::jsonb,
  status text not null default 'unread'
    check (status in ('unread', 'read', 'needs_reply', 'drafted', 'approved', 'replied', 'moderated', 'ignored', 'failed')),
  analysis jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, provider_event_id)
);

create table if not exists public.response_actions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  response_event_id uuid references public.response_events(id) on delete set null,
  provider text not null,
  platform text not null,
  action_type text not null,
  idempotency_key text not null,
  draft_text text,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'processing', 'sent', 'completed', 'failed', 'cancelled')),
  approved_by uuid,
  approved_at timestamptz,
  provider_action_id text,
  receipt jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists public.provider_sync_cursors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  connected_account_id uuid references public.connected_accounts(id) on delete cascade,
  provider text not null,
  platform text not null,
  sync_kind text not null,
  cursor jsonb not null default '{}'::jsonb,
  status text not null default 'idle'
    check (status in ('idle', 'queued', 'running', 'completed', 'failed', 'blocked')),
  next_sync_at timestamptz not null default now(),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists provider_sync_cursors_account_kind_uidx
  on public.provider_sync_cursors(workspace_id, connected_account_id, sync_kind)
  where connected_account_id is not null;

create unique index if not exists provider_sync_cursors_platform_kind_uidx
  on public.provider_sync_cursors(workspace_id, platform, sync_kind)
  where connected_account_id is null;

create table if not exists public.audience_briefs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  brief_date date not null,
  evidence_from timestamptz,
  evidence_to timestamptz,
  status text not null default 'ready'
    check (status in ('queued', 'processing', 'ready', 'failed')),
  brief jsonb not null default '{}'::jsonb,
  model text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, brief_date)
);

create table if not exists public.provider_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  feature text not null,
  idempotency_key text not null,
  usage_bucket date not null default current_date,
  status text not null default 'reserved'
    check (status in ('reserved', 'completed', 'failed', 'cancelled')),
  unit text not null default 'request',
  quantity numeric(18,6) not null default 1,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  estimated_cost_microusd bigint not null default 0,
  actual_cost_microusd bigint not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  device_id text not null,
  endpoint_hash text not null,
  encrypted_subscription jsonb not null,
  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired', 'failed')),
  last_used_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id, endpoint_hash)
);

create index if not exists response_events_workspace_inbox_idx
  on public.response_events(workspace_id, status, observed_at desc);
create index if not exists response_events_conversation_idx
  on public.response_events(workspace_id, provider, conversation_id, observed_at desc);
create index if not exists response_events_connected_account_idx
  on public.response_events(connected_account_id);
create index if not exists response_actions_event_idx
  on public.response_actions(workspace_id, response_event_id, created_at desc);
create index if not exists response_actions_response_event_idx
  on public.response_actions(response_event_id);
create index if not exists provider_sync_cursors_due_idx
  on public.provider_sync_cursors(status, next_sync_at);
create index if not exists provider_sync_cursors_connected_account_idx
  on public.provider_sync_cursors(connected_account_id);
create index if not exists audience_briefs_workspace_date_idx
  on public.audience_briefs(workspace_id, brief_date desc);
create index if not exists provider_usage_ledger_window_idx
  on public.provider_usage_ledger(workspace_id, provider, feature, usage_bucket, created_at desc);
create index if not exists push_subscriptions_workspace_idx
  on public.push_subscriptions(workspace_id, user_id, status);

alter table public.response_events enable row level security;
alter table public.response_actions enable row level security;
alter table public.provider_sync_cursors enable row level security;
alter table public.audience_briefs enable row level security;
alter table public.provider_usage_ledger enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists server_only_deny_all on public.response_events;
drop policy if exists server_only_deny_all on public.response_actions;
drop policy if exists server_only_deny_all on public.provider_sync_cursors;
drop policy if exists server_only_deny_all on public.audience_briefs;
drop policy if exists server_only_deny_all on public.provider_usage_ledger;
drop policy if exists server_only_deny_all on public.push_subscriptions;
create policy server_only_deny_all on public.response_events for all to public using (false) with check (false);
create policy server_only_deny_all on public.response_actions for all to public using (false) with check (false);
create policy server_only_deny_all on public.provider_sync_cursors for all to public using (false) with check (false);
create policy server_only_deny_all on public.audience_briefs for all to public using (false) with check (false);
create policy server_only_deny_all on public.provider_usage_ledger for all to public using (false) with check (false);
create policy server_only_deny_all on public.push_subscriptions for all to public using (false) with check (false);

revoke all on table public.response_events from public, anon, authenticated;
revoke all on table public.response_actions from public, anon, authenticated;
revoke all on table public.provider_sync_cursors from public, anon, authenticated;
revoke all on table public.audience_briefs from public, anon, authenticated;
revoke all on table public.provider_usage_ledger from public, anon, authenticated;
revoke all on table public.push_subscriptions from public, anon, authenticated;

grant select, insert, update, delete on table public.response_events to service_role;
grant select, insert, update, delete on table public.response_actions to service_role;
grant select, insert, update, delete on table public.provider_sync_cursors to service_role;
grant select, insert, update, delete on table public.audience_briefs to service_role;
grant select, insert, update, delete on table public.provider_usage_ledger to service_role;
grant select, insert, update, delete on table public.push_subscriptions to service_role;

create or replace function public.social_cues_claim_usage_allowance(
  p_workspace_id uuid,
  p_user_id uuid,
  p_provider text,
  p_feature text,
  p_idempotency_key text,
  p_daily_limit integer,
  p_metadata jsonb default '{}'::jsonb
)
returns table(allowed boolean, used integer, remaining integer, ledger_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_used integer;
  existing_id uuid;
  inserted_id uuid;
begin
  if p_workspace_id is null or p_user_id is null or coalesce(p_idempotency_key, '') = '' then
    raise exception 'workspace, user, and idempotency key are required';
  end if;
  if p_daily_limit < 1 then
    return query select false, 0, 0, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || p_provider || ':' || p_feature || ':' || current_date::text,
    0
  ));

  select id into existing_id
  from public.provider_usage_ledger
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key
  limit 1;

  select count(*)::integer into current_used
  from public.provider_usage_ledger
  where workspace_id = p_workspace_id
    and provider = p_provider
    and feature = p_feature
    and usage_bucket = current_date
    and status <> 'cancelled';

  if existing_id is not null then
    return query select true, current_used, greatest(0, p_daily_limit - current_used), existing_id;
    return;
  end if;

  if current_used >= p_daily_limit then
    return query select false, current_used, 0, null::uuid;
    return;
  end if;

  insert into public.provider_usage_ledger (
    workspace_id, user_id, provider, feature, idempotency_key, metadata
  ) values (
    p_workspace_id, p_user_id, p_provider, p_feature, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into inserted_id;

  return query select true, current_used + 1, greatest(0, p_daily_limit - current_used - 1), inserted_id;
end;
$$;

revoke all on function public.social_cues_claim_usage_allowance(uuid, uuid, text, text, text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.social_cues_claim_usage_allowance(uuid, uuid, text, text, text, integer, jsonb)
  to service_role;

create or replace function public.social_cues_claim_openai_allowance(
  p_workspace_id uuid,
  p_user_id uuid,
  p_feature text,
  p_idempotency_key text,
  p_daily_request_limit integer,
  p_monthly_request_limit integer,
  p_monthly_token_limit bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns table(
  allowed boolean,
  daily_used integer,
  monthly_used integer,
  monthly_tokens bigint,
  ledger_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  used_today integer;
  used_month integer;
  tokens_month bigint;
  existing_id uuid;
  inserted_id uuid;
begin
  if p_workspace_id is null or p_user_id is null or coalesce(p_idempotency_key, '') = '' then
    raise exception 'workspace, user, and idempotency key are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':openai', 0));

  select id into existing_id
  from public.provider_usage_ledger
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key
  limit 1;

  select
    count(*) filter (where created_at >= date_trunc('day', now()))::integer,
    count(*)::integer,
    coalesce(sum(total_tokens), 0)::bigint
  into used_today, used_month, tokens_month
  from public.provider_usage_ledger
  where workspace_id = p_workspace_id
    and provider = 'openai'
    and created_at >= date_trunc('month', now())
    and status <> 'cancelled';

  if existing_id is not null then
    return query select true, used_today, used_month, tokens_month, existing_id;
    return;
  end if;

  if used_today >= p_daily_request_limit
    or used_month >= p_monthly_request_limit
    or tokens_month >= p_monthly_token_limit then
    return query select false, used_today, used_month, tokens_month, null::uuid;
    return;
  end if;

  insert into public.provider_usage_ledger (
    workspace_id, user_id, provider, feature, idempotency_key, metadata
  ) values (
    p_workspace_id, p_user_id, 'openai', p_feature, p_idempotency_key, coalesce(p_metadata, '{}'::jsonb)
  ) returning id into inserted_id;

  return query select true, used_today + 1, used_month + 1, tokens_month, inserted_id;
end;
$$;

revoke all on function public.social_cues_claim_openai_allowance(uuid, uuid, text, text, integer, integer, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.social_cues_claim_openai_allowance(uuid, uuid, text, text, integer, integer, bigint, jsonb)
  to service_role;
