-- Durable, tenant-isolated provider API quota buckets.
-- Apply with the Supabase migration flow. Only the service role can read or claim quota.

create table if not exists public.provider_api_rate_buckets (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  connected_account_id uuid not null references public.connected_accounts(id) on delete cascade,
  provider text not null,
  bucket text not null,
  window_started_at timestamptz not null default now(),
  window_seconds integer not null check (window_seconds between 1 and 86400),
  used integer not null default 0 check (used >= 0),
  limit_value integer not null check (limit_value > 0),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, connected_account_id, provider, bucket)
);

alter table public.provider_api_rate_buckets enable row level security;

revoke all on table public.provider_api_rate_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.provider_api_rate_buckets to service_role;
drop policy if exists "provider quota buckets are service role only" on public.provider_api_rate_buckets;
create policy "provider quota buckets are service role only" on public.provider_api_rate_buckets
  for all to anon, authenticated using (false) with check (false);

create index if not exists provider_api_rate_buckets_window_idx
  on public.provider_api_rate_buckets(provider, window_started_at);

create index if not exists provider_api_rate_buckets_account_idx
  on public.provider_api_rate_buckets(connected_account_id);

create or replace function public.social_cues_claim_provider_api_quota(
  p_workspace_id uuid,
  p_connected_account_id uuid,
  p_provider text,
  p_bucket text,
  p_window_seconds integer,
  p_limit integer,
  p_units integer default 1
)
returns table (
  allowed boolean,
  used integer,
  remaining integer,
  retry_after_seconds integer,
  window_started_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.provider_api_rate_buckets%rowtype;
  v_now timestamptz := now();
begin
  if p_workspace_id is null or p_connected_account_id is null then
    raise exception 'workspace and connected account are required';
  end if;
  if coalesce(trim(p_provider), '') = '' or coalesce(trim(p_bucket), '') = '' then
    raise exception 'provider and bucket are required';
  end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 or p_limit < 1 or p_units < 1 then
    raise exception 'invalid provider quota policy';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', p_workspace_id::text, p_connected_account_id::text, lower(p_provider), p_bucket),
    0
  ));

  select * into v_row
  from public.provider_api_rate_buckets
  where workspace_id = p_workspace_id
    and connected_account_id = p_connected_account_id
    and provider = lower(p_provider)
    and bucket = p_bucket
  for update;

  if not found then
    insert into public.provider_api_rate_buckets (
      workspace_id, connected_account_id, provider, bucket,
      window_started_at, window_seconds, used, limit_value, updated_at
    ) values (
      p_workspace_id, p_connected_account_id, lower(p_provider), p_bucket,
      v_now, p_window_seconds, p_units, p_limit, v_now
    ) returning * into v_row;
    return query select true, v_row.used, greatest(0, p_limit - v_row.used), 0, v_row.window_started_at;
    return;
  end if;

  if v_row.window_started_at + make_interval(secs => v_row.window_seconds) <= v_now then
    update public.provider_api_rate_buckets
    set window_started_at = v_now,
        window_seconds = p_window_seconds,
        used = p_units,
        limit_value = p_limit,
        updated_at = v_now
    where workspace_id = p_workspace_id
      and connected_account_id = p_connected_account_id
      and provider = lower(p_provider)
      and bucket = p_bucket
    returning * into v_row;
    return query select true, v_row.used, greatest(0, p_limit - v_row.used), 0, v_row.window_started_at;
    return;
  end if;

  if v_row.used + p_units > p_limit then
    return query select
      false,
      v_row.used,
      greatest(0, p_limit - v_row.used),
      greatest(1, ceil(extract(epoch from (
        v_row.window_started_at + make_interval(secs => v_row.window_seconds) - v_now
      )))::integer),
      v_row.window_started_at;
    return;
  end if;

  update public.provider_api_rate_buckets
  set used = provider_api_rate_buckets.used + p_units,
      window_seconds = p_window_seconds,
      limit_value = p_limit,
      updated_at = v_now
  where workspace_id = p_workspace_id
    and connected_account_id = p_connected_account_id
    and provider = lower(p_provider)
    and bucket = p_bucket
  returning * into v_row;

  return query select true, v_row.used, greatest(0, p_limit - v_row.used), 0, v_row.window_started_at;
end;
$$;

revoke all on function public.social_cues_claim_provider_api_quota(uuid, uuid, text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.social_cues_claim_provider_api_quota(uuid, uuid, text, text, integer, integer, integer) to service_role;
