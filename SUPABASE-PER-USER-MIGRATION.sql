-- Social Cues clean per-user data migration
-- Apply in Supabase SQL editor or via an authenticated Supabase migration flow.
-- This file is additive and keeps app_state.primary as a temporary compatibility bridge.

create extension if not exists pgcrypto;

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  platform text not null,
  provider_account_id text,
  display_name text,
  handle text,
  status text not null default 'not_connected',
  scopes text[] not null default '{}',
  public_profile jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, platform, provider_account_id)
);

create table if not exists public.provider_tokens (
  id uuid primary key default gen_random_uuid(),
  connected_account_id uuid not null references public.connected_accounts(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  provider text not null,
  token_kind text not null default 'oauth',
  encrypted_token jsonb not null,
  encrypted_refresh_token jsonb,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connected_account_id, token_kind)
);

create table if not exists public.device_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  device_id text not null,
  session_token_hash text not null,
  encrypted_refresh_credential jsonb,
  auth_token_expires_at timestamptz,
  session_provider text not null default 'supabase',
  name text,
  kind text,
  user_agent text,
  platform text,
  language text,
  screen text,
  time_zone text,
  trusted boolean not null default true,
  login_count integer not null default 0,
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, device_id)
);

alter table public.device_sessions
  add column if not exists encrypted_refresh_credential jsonb,
  add column if not exists auth_token_expires_at timestamptz,
  add column if not exists session_provider text not null default 'supabase';

create table if not exists public.billing_entitlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  source text not null,
  access text not null,
  status text not null default 'active',
  promo_code text,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One authoritative entitlement row per workspace user. The cleanup is safe to
-- re-run and keeps the most recently updated row before uniqueness is enforced.
delete from public.billing_entitlements older
using public.billing_entitlements newer
where older.workspace_id = newer.workspace_id
  and older.user_id = newer.user_id
  and (older.updated_at, older.created_at, older.id) < (newer.updated_at, newer.created_at, newer.id);

alter table public.billing_entitlements alter column user_id set not null;
create unique index if not exists billing_entitlements_workspace_user_uidx
  on public.billing_entitlements(workspace_id, user_id);

create table if not exists public.analytics_snapshots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null,
  provider text,
  platform text,
  metric_date date,
  metrics jsonb not null default '{}'::jsonb,
  translated_analysis jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  user_id uuid,
  event_type text not null,
  provider text,
  platform text,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  status text not null default 'processing',
  attempts integer not null default 1,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  unique (provider, event_id)
);

alter table public.scheduled_posts
  add column if not exists external_key text,
  add column if not exists idempotency_key text,
  add column if not exists retry_count integer not null default 0,
  add column if not exists max_attempts integer not null default 5,
  add column if not exists next_retry_at timestamptz,
  add column if not exists last_attempt_at timestamptz;

alter table public.analytics_snapshots
  add column if not exists external_key text,
  add column if not exists publish_idempotency_keys text[] not null default '{}';

create table if not exists public.publish_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  queue_external_key text,
  campaign_external_id text,
  variant_external_id text,
  provider text not null,
  platform text not null,
  idempotency_key text not null,
  provider_post_id text,
  status text not null,
  published_at timestamptz,
  receipt_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  idempotency_key text not null,
  type text not null,
  channel text not null default 'in-app',
  target text,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invited_by_user_id uuid not null,
  invited_email text not null,
  role text not null default 'member' check (role in ('owner', 'admin', 'member', 'viewer')),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by_user_id uuid,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.auth_rate_limits (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  identity_hash text not null,
  attempted_at timestamptz not null default now()
);

create or replace function public.social_cues_claim_auth_rate_limit(
  p_action text,
  p_identity_hash text,
  p_window_seconds integer,
  p_max_attempts integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  attempt_count integer;
  oldest_attempt timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_action || ':' || p_identity_hash, 0));

  delete from public.auth_rate_limits
  where action = p_action
    and identity_hash = p_identity_hash
    and attempted_at < now() - make_interval(secs => greatest(p_window_seconds * 2, 3600));

  select count(*), min(attempted_at)
    into attempt_count, oldest_attempt
  from public.auth_rate_limits
  where action = p_action
    and identity_hash = p_identity_hash
    and attempted_at >= now() - make_interval(secs => p_window_seconds);

  if attempt_count >= p_max_attempts then
    return query select
      false,
      0,
      greatest(1, ceil(extract(epoch from ((oldest_attempt + make_interval(secs => p_window_seconds)) - now())))::integer);
    return;
  end if;

  insert into public.auth_rate_limits(action, identity_hash) values (p_action, p_identity_hash);
  return query select true, greatest(0, p_max_attempts - attempt_count - 1), 0;
end;
$$;

revoke all on function public.social_cues_claim_auth_rate_limit(text, text, integer, integer) from public;
revoke all on function public.social_cues_claim_auth_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.social_cues_claim_auth_rate_limit(text, text, integer, integer) from authenticated;
grant execute on function public.social_cues_claim_auth_rate_limit(text, text, integer, integer) to service_role;

alter table public.workspace_members enable row level security;
alter table public.connected_accounts enable row level security;
alter table public.provider_tokens enable row level security;
alter table public.device_sessions enable row level security;
alter table public.billing_entitlements enable row level security;
alter table public.analytics_snapshots enable row level security;
alter table public.audit_logs enable row level security;
alter table public.webhook_events enable row level security;
alter table public.auth_rate_limits enable row level security;
alter table public.publish_receipts enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.workspace_invites enable row level security;

revoke all on table public.provider_tokens, public.webhook_events,
  public.auth_rate_limits, public.publish_receipts, public.notification_outbox,
  public.workspace_invites from public, anon, authenticated;

drop policy if exists "provider tokens are service role only" on public.provider_tokens;
create policy "provider tokens are service role only" on public.provider_tokens
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "webhook events are service role only" on public.webhook_events;
create policy "webhook events are service role only" on public.webhook_events
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "auth rate limits are service role only" on public.auth_rate_limits;
create policy "auth rate limits are service role only" on public.auth_rate_limits
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "publish receipts are service role only" on public.publish_receipts;
create policy "publish receipts are service role only" on public.publish_receipts
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "notification outbox is service role only" on public.notification_outbox;
create policy "notification outbox is service role only" on public.notification_outbox
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "workspace invites are service role only" on public.workspace_invites;
create policy "workspace invites are service role only" on public.workspace_invites
  for all to anon, authenticated using (false) with check (false);

create policy "members can read own memberships"
  on public.workspace_members for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.social_cues_has_active_entitlement(target_workspace_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from public.billing_entitlements be
    where be.workspace_id = target_workspace_id
      and (be.user_id is null or be.user_id = target_user_id)
      and be.status = 'active'
      and coalesce(be.access, 'unpaid') <> 'unpaid'
      and (be.current_period_end is null or be.current_period_end > now())
  );
$$;

revoke all on function public.social_cues_has_active_entitlement(uuid, uuid) from public;
grant execute on function public.social_cues_has_active_entitlement(uuid, uuid) to authenticated;

create policy "members can read connected accounts"
  on public.connected_accounts for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = connected_accounts.workspace_id
      and workspace_members.user_id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(connected_accounts.workspace_id, (select auth.uid()))
  );

create policy "members can read own device sessions"
  on public.device_sessions for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy "members can read billing entitlements"
  on public.billing_entitlements for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = billing_entitlements.workspace_id
      and workspace_members.user_id = (select auth.uid())
    )
  );

create policy "members can read analytics snapshots"
  on public.analytics_snapshots for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = analytics_snapshots.workspace_id
      and workspace_members.user_id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(analytics_snapshots.workspace_id, (select auth.uid()))
  );

create policy "members can read audit logs"
  on public.audit_logs for select
  to authenticated
  using (
    exists (
      select 1 from public.workspace_members
      where workspace_members.workspace_id = audit_logs.workspace_id
      and workspace_members.user_id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(audit_logs.workspace_id, (select auth.uid()))
  );

-- Intentionally no authenticated select/insert/update/delete policy for provider_tokens.
-- Provider token material is server-only and should be accessed only through backend service credentials.
-- Webhook event claims are also server-only because they protect payment and provider idempotency.

create index if not exists workspace_members_user_idx on public.workspace_members(user_id);
create index if not exists connected_accounts_workspace_idx on public.connected_accounts(workspace_id);
create index if not exists connected_accounts_user_idx on public.connected_accounts(user_id);
create index if not exists provider_tokens_account_idx on public.provider_tokens(connected_account_id);
create index if not exists provider_tokens_workspace_idx on public.provider_tokens(workspace_id);
create index if not exists device_sessions_user_idx on public.device_sessions(user_id);
create index if not exists device_sessions_workspace_idx on public.device_sessions(workspace_id);
create index if not exists billing_entitlements_workspace_idx on public.billing_entitlements(workspace_id);
create index if not exists analytics_snapshots_workspace_idx on public.analytics_snapshots(workspace_id, metric_date);
create index if not exists audit_logs_workspace_idx on public.audit_logs(workspace_id, created_at desc);
create index if not exists webhook_events_status_idx on public.webhook_events(provider, status, received_at desc);
create index if not exists auth_rate_limits_lookup_idx on public.auth_rate_limits(action, identity_hash, attempted_at desc);
create unique index if not exists scheduled_posts_workspace_external_uidx on public.scheduled_posts(workspace_id, external_key);
create unique index if not exists analytics_snapshots_workspace_external_uidx on public.analytics_snapshots(workspace_id, external_key);
create index if not exists scheduled_posts_worker_idx on public.scheduled_posts(status, next_retry_at, scheduled_for);
create index if not exists publish_receipts_variant_idx on public.publish_receipts(workspace_id, variant_external_id, published_at desc);
create index if not exists notification_outbox_worker_idx on public.notification_outbox(status, next_attempt_at, created_at);
create index if not exists workspace_invites_lookup_idx on public.workspace_invites(workspace_id, invited_email, status, expires_at);
