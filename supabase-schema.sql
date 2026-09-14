-- Social Cues Supabase starter schema
-- Run this in the Supabase SQL editor for the alpha backend.
-- Keep service-role keys on the server only.

create extension if not exists pgcrypto;

create table if not exists public.app_state (
  id text primary key default 'primary',
  model jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid,
  name text not null,
  plan text not null default 'founder_alpha',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-workspace model snapshots are the migration bridge away from the legacy
-- app_state.primary JSON document. The server can mirror isolated workspace
-- state here while feature tables are adopted endpoint by endpoint.
create table if not exists public.workspace_models (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  owner_user_id uuid not null,
  model jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- These two ownership/worker foundations are included here so the hosted
-- workspace persistence v2 block at the end of this clean-install schema has
-- the same prerequisite catalog as the additive migration path.
create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  membership_status text not null default 'active'
    check (membership_status in ('active', 'inactive', 'removed')),
  primary key (workspace_id, user_id)
);

create table if not exists public.worker_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  kind text not null,
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'retrying', 'completed', 'blocked', 'dead', 'cancelled')),
  idempotency_key text not null,
  priority smallint not null default 50 check (priority between 0 and 100),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  run_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  last_error text,
  estimated_cost_microusd bigint not null default 0 check (estimated_cost_microusd >= 0),
  actual_cost_microusd bigint not null default 0 check (actual_cost_microusd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  workspace_persistence_lease_id uuid,
  workspace_persistence_intent text,
  unique (workspace_id, idempotency_key),
  constraint worker_jobs_workspace_persistence_binding_check check (
    (workspace_persistence_lease_id is null and workspace_persistence_intent is null)
    or (
      workspace_persistence_lease_id is not null
      and workspace_persistence_intent in (
        'workspace.content-result','workspace.provider-state-result',
        'workspace.worker-result','workspace.system-repair'
      )
    )
  )
);

create table if not exists public.profiles (
  id uuid primary key,
  workspace_id uuid references public.workspaces(id) on delete cascade,
  display_name text,
  email text,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  platform text not null,
  handle text,
  status text not null default 'not_connected',
  scopes text[] not null default '{}',
  token_ref text,
  last_analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, platform)
);

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  goal text,
  brief text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.content_variants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.campaigns(id) on delete cascade,
  platform text not null,
  status text not null default 'draft',
  copy text,
  tags text[] not null default '{}',
  best_time text,
  media_asset_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.scheduled_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  content_variant_id uuid references public.content_variants(id) on delete set null,
  platform text not null,
  status text not null default 'queued',
  caption text,
  tags text[] not null default '{}',
  media_asset_id uuid,
  scheduled_for timestamptz not null,
  published_at timestamptz,
  reminder_sent_at timestamptz,
  provider_post_id text,
  publish_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  provider text not null default 'upload',
  kind text not null default 'image',
  title text,
  prompt text,
  storage_path text,
  preview_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.action_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  type text not null default 'experiment',
  priority text not null default 'medium',
  status text not null default 'active',
  title text not null,
  signal text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  stripe_customer_id text,
  selected_plan text,
  status text not null default 'not_configured',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_entitlements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null,
  source text not null default 'unknown',
  access text not null default 'unpaid',
  status text not null default 'inactive',
  promo_code text,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

delete from public.billing_entitlements older
using public.billing_entitlements newer
where older.workspace_id = newer.workspace_id
  and older.user_id = newer.user_id
  and (older.updated_at, older.created_at, older.id) < (newer.updated_at, newer.created_at, newer.id);

alter table public.billing_entitlements alter column user_id set not null;
create unique index if not exists billing_entitlements_workspace_user_uidx
  on public.billing_entitlements(workspace_id, user_id);

alter table public.app_state enable row level security;
alter table public.workspace_models enable row level security;
alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.social_accounts enable row level security;
alter table public.campaigns enable row level security;
alter table public.content_variants enable row level security;
alter table public.scheduled_posts enable row level security;
alter table public.media_assets enable row level security;
alter table public.action_items enable row level security;
alter table public.billing_customers enable row level security;
alter table public.billing_entitlements enable row level security;

revoke all on table public.app_state from public, anon, authenticated;
drop policy if exists "server registry is service role only" on public.app_state;
create policy "server registry is service role only"
  on public.app_state for all
  to anon, authenticated
  using (false)
  with check (false);

create policy "profiles can read own profile"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

create policy "profiles can update own profile"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

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

create policy "users can read own workspace model"
  on public.workspace_models for select
  to authenticated
  using ((select auth.uid()) = owner_user_id and public.social_cues_has_active_entitlement(workspace_id, (select auth.uid())));

create policy "users can insert own workspace model"
  on public.workspace_models for insert
  to authenticated
  with check ((select auth.uid()) = owner_user_id and public.social_cues_has_active_entitlement(workspace_id, (select auth.uid())));

create policy "users can update own workspace model"
  on public.workspace_models for update
  to authenticated
  using ((select auth.uid()) = owner_user_id and public.social_cues_has_active_entitlement(workspace_id, (select auth.uid())))
  with check ((select auth.uid()) = owner_user_id and public.social_cues_has_active_entitlement(workspace_id, (select auth.uid())));

create policy "workspace members can read workspace"
  on public.workspaces for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = workspaces.id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(workspaces.id, (select auth.uid()))
  );

create policy "workspace members can read social accounts"
  on public.social_accounts for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = social_accounts.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(social_accounts.workspace_id, (select auth.uid()))
  );

create policy "workspace members can read campaigns"
  on public.campaigns for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = campaigns.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(campaigns.workspace_id, (select auth.uid()))
  );

create policy "workspace members can read variants"
  on public.content_variants for select
  to authenticated
  using (
    exists (
      select 1
      from public.campaigns
      join public.profiles on profiles.workspace_id = campaigns.workspace_id
      where campaigns.id = content_variants.campaign_id
      and profiles.id = (select auth.uid())
      and public.social_cues_has_active_entitlement(campaigns.workspace_id, (select auth.uid()))
    )
  );

create policy "workspace members can read scheduled posts"
  on public.scheduled_posts for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = scheduled_posts.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(scheduled_posts.workspace_id, (select auth.uid()))
  );

create policy "workspace members can read media"
  on public.media_assets for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = media_assets.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(media_assets.workspace_id, (select auth.uid()))
  );

create policy "workspace members can create media"
  on public.media_assets for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = media_assets.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(media_assets.workspace_id, (select auth.uid()))
  );

create policy "workspace members can update media"
  on public.media_assets for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = media_assets.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(media_assets.workspace_id, (select auth.uid()))
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = media_assets.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(media_assets.workspace_id, (select auth.uid()))
  );

create policy "workspace members can read actions"
  on public.action_items for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = action_items.workspace_id
      and profiles.id = (select auth.uid())
    )
    and public.social_cues_has_active_entitlement(action_items.workspace_id, (select auth.uid()))
  );

create policy "workspace members can read billing"
  on public.billing_customers for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = billing_customers.workspace_id
      and profiles.id = (select auth.uid())
    )
  );

create policy "members can read billing entitlements"
  on public.billing_entitlements for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.workspace_id = billing_entitlements.workspace_id
      and profiles.id = (select auth.uid())
    )
  );

create index if not exists social_accounts_workspace_idx on public.social_accounts(workspace_id);
create index if not exists campaigns_workspace_idx on public.campaigns(workspace_id);
create index if not exists variants_campaign_idx on public.content_variants(campaign_id);
create index if not exists scheduled_posts_workspace_idx on public.scheduled_posts(workspace_id);
create index if not exists scheduled_posts_due_idx on public.scheduled_posts(status, scheduled_for);
create index if not exists media_workspace_idx on public.media_assets(workspace_id);
create index if not exists actions_workspace_idx on public.action_items(workspace_id);
create index if not exists profiles_workspace_idx on public.profiles(workspace_id);
create index if not exists billing_customers_workspace_idx on public.billing_customers(workspace_id);
create index if not exists device_sessions_workspace_idx on public.device_sessions(workspace_id);
create index if not exists scheduled_posts_campaign_idx on public.scheduled_posts(campaign_id);
create index if not exists scheduled_posts_variant_idx on public.scheduled_posts(content_variant_id);

-- Supabase Storage bucket for user-uploaded raw media and generated derivatives.
-- Object paths should start with the authenticated user's UUID when uploaded directly from the browser.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'social-cues-media',
  'social-cues-media',
  false,
  262144000,
  array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/quicktime','video/webm','audio/mpeg','audio/mp4','audio/wav','audio/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "users can read own media objects"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'social-cues-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "users can insert own media objects"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'social-cues-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Hosted workspace persistence v2 (R4.3). Keep this block byte-equivalent in
-- behavior to SUPABASE-WORKSPACE-PERSISTENCE-V2.sql.
-- Social Cues hosted workspace persistence v2
-- Additive, rerunnable R4.3 migration. Apply only after the per-user and
-- durable-worker foundations. Browser clients use the RPCs below; they never
-- receive direct table privileges.

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.workspaces') is null
    or to_regclass('public.workspace_models') is null
    or to_regclass('public.workspace_members') is null
    or to_regclass('public.billing_entitlements') is null
    or to_regclass('public.worker_jobs') is null then
    raise exception using
      errcode = '55000',
      message = 'workspace persistence v2 prerequisites are missing';
  end if;
end;
$$;

create schema if not exists social_cues_private;
revoke all on schema social_cues_private from public;

create or replace function social_cues_private.workspace_fail_v2(error_code text)
returns void
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $$
declare
  error_state text;
begin
  error_state := case error_code
    when 'workspace_input_invalid' then 'PT400'
    when 'authentication_required' then 'PT401'
    when 'workspace_authorization_failed' then 'PT403'
    when 'workspace_revision_conflict' then 'PT409'
    when 'workspace_operation_id_reused' then 'PT409'
    when 'workspace_revision_required' then 'PT428'
    else 'PT503'
  end;
  raise exception using errcode = error_state, message = error_code;
end;
$$;

create or replace function social_cues_private.workspace_safe_uuid_v2(value text)
returns uuid
language plpgsql
immutable
parallel safe
security invoker
set search_path = pg_catalog
as $$
begin
  if value is null
    or value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return null;
  end if;
  return value::uuid;
exception when others then
  return null;
end;
$$;

create or replace function social_cues_private.workspace_revision_valid_v2(value text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select value is not null and value ~ '^(0|[1-9][0-9]{0,127})$';
$$;

create or replace function social_cues_private.workspace_hash_valid_v2(value text)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select value is not null and value ~ '^[0-9a-f]{64}$';
$$;

create or replace function social_cues_private.workspace_claims_v2()
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog
as $$
declare
  raw_claims text;
begin
  raw_claims := current_setting('request.jwt.claims', true);
  if raw_claims is null or btrim(raw_claims) = '' then
    return '{}'::jsonb;
  end if;
  return raw_claims::jsonb;
exception when others then
  return '{}'::jsonb;
end;
$$;

create or replace function social_cues_private.workspace_canonical_number_v2(value jsonb)
returns text
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
set extra_float_digits = 3
as $$
declare
  number_value double precision;
  rendered text;
  sign_prefix text := '';
  exponent_marker integer;
  exponent_value integer := 0;
  mantissa text;
  decimal_marker integer;
  decimal_position integer;
  digits text;
  leading_zero_count integer;
  significant text;
  magnitude_exponent integer;
begin
  number_value := (value #>> '{}')::double precision;
  rendered := number_value::text;
  if rendered in ('Infinity', '-Infinity', 'NaN') then
    raise exception 'workspace number is outside the finite IEEE 754 range' using errcode = '22023';
  end if;
  if number_value = 0 then return '0'; end if;

  if left(rendered, 1) = '-' then
    sign_prefix := '-';
    rendered := substr(rendered, 2);
  end if;
  exponent_marker := strpos(lower(rendered), 'e');
  if exponent_marker > 0 then
    mantissa := left(rendered, exponent_marker - 1);
    exponent_value := substr(rendered, exponent_marker + 1)::integer;
  else
    mantissa := rendered;
  end if;

  decimal_marker := strpos(mantissa, '.');
  decimal_position := case when decimal_marker > 0 then decimal_marker - 1 else length(mantissa) end
    + exponent_value;
  digits := replace(mantissa, '.', '');
  leading_zero_count := length(digits) - length(ltrim(digits, '0'));
  digits := substr(digits, leading_zero_count + 1);
  decimal_position := decimal_position - leading_zero_count;
  significant := rtrim(digits, '0');
  if significant = '' then return '0'; end if;

  magnitude_exponent := decimal_position - 1;
  if magnitude_exponent >= 21 or magnitude_exponent <= -7 then
    return sign_prefix || left(significant, 1)
      || case when length(significant) > 1 then '.' || substr(significant, 2) else '' end
      || 'e' || case when magnitude_exponent >= 0 then '+' else '' end || magnitude_exponent::text;
  end if;
  if decimal_position <= 0 then
    return sign_prefix || '0.' || repeat('0', -decimal_position) || significant;
  end if;
  if decimal_position >= length(significant) then
    return sign_prefix || significant || repeat('0', decimal_position - length(significant));
  end if;
  return sign_prefix || left(significant, decimal_position) || '.' || substr(significant, decimal_position + 1);
end;
$$;

create or replace function social_cues_private.workspace_canonical_json_v2(value jsonb)
returns text
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
declare
  result text;
begin
  case jsonb_typeof(value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(entry.key)::text || ':' ||
        social_cues_private.workspace_canonical_json_v2(entry.value), ',' order by entry.key), '') || '}'
      into result
      from jsonb_each(value) as entry;
      return result;
    when 'array' then
      select '[' || coalesce(string_agg(
        social_cues_private.workspace_canonical_json_v2(entry.value), ',' order by entry.ordinality), '') || ']'
      into result
      from jsonb_array_elements(value) with ordinality as entry(value, ordinality);
      return result;
    when 'number' then
      return social_cues_private.workspace_canonical_number_v2(value);
    else
      return value::text;
  end case;
end;
$$;

create or replace function social_cues_private.workspace_canonical_hash_v2(value jsonb)
returns text
language sql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select encode(
    public.digest(convert_to(social_cues_private.workspace_canonical_json_v2(value), 'UTF8'), 'sha256'),
    'hex'
  );
$$;

create or replace function social_cues_private.workspace_tree_nodes_v2(value jsonb)
returns bigint
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
declare
  total bigint := 1;
  child jsonb;
begin
  if jsonb_typeof(value) = 'array' then
    for child in select item from jsonb_array_elements(value) as items(item) loop
      total := total + social_cues_private.workspace_tree_nodes_v2(child);
      if total > 10000 then return total; end if;
    end loop;
  elsif jsonb_typeof(value) = 'object' then
    for child in select item from jsonb_each(value) as items(key, item) loop
      total := total + social_cues_private.workspace_tree_nodes_v2(child);
      if total > 10000 then return total; end if;
    end loop;
  end if;
  return total;
end;
$$;

create or replace function social_cues_private.workspace_public_tree_valid_v2(value jsonb, depth integer default 0)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
declare
  entry record;
  normalized_key text;
  forbidden_exact constant text[] := array[
    'accesstoken','actoruserid','auth','authentication','authorization','authusers',
    'billingcustomerid','billingprivate','billingsubscriptionid','callbackbody','currentuser',
    'commitreceipt','commitreceipts','contenthash','cookie','devicecredential','devicecredentials',
    'deviceauth','devicesecret','devicesession','devicesessions','encryptedtoken','jwttoken',
    'leasetoken','oauthstate','oauthstates','operationid','owneruserid','password','passwordhash',
    'paymentmethod','persistenceepoch','privatebilling','privatereceipt','providertoken',
    'providertokenciphertext','rawcallbackbody','rawwebhookbody','receipt','receipts',
    'refreshtoken','servicecredential','servicecredentials','servicekey','servicerolekey',
    'sessiontoken','webhookbody','webhookevent','webhookevents','webhooksecret','webhooksignature',
    'workerlease','workerleases','workspaceid'
  ];
  forbidden_fragments constant text[] := array[
    'accesstoken','authorization','billing','ciphertext','credential','deviceauth','oauthstate',
    'password','paymentmethod','privatereceipt','providertoken','refreshtoken','secret','servicekey',
    'sessiontoken','stripecustomer','stripesubscription','webhookbody','webhookevent','webhooksecret',
    'workerlease'
  ];
  fragment text;
begin
  if depth > 20 then return false; end if;

  if jsonb_typeof(value) = 'string' then
    return octet_length(value #>> '{}') <= 65536;
  end if;

  if jsonb_typeof(value) = 'array' then
    if jsonb_array_length(value) > 2000 then return false; end if;
    for entry in select item from jsonb_array_elements(value) as items(item) loop
      if not social_cues_private.workspace_public_tree_valid_v2(entry.item, depth + 1) then return false; end if;
    end loop;
    return true;
  end if;

  if jsonb_typeof(value) = 'object' then
    if (select count(*) from jsonb_object_keys(value)) > 256 then return false; end if;
    for entry in select key, item from jsonb_each(value) as items(key, item) loop
      if entry.key !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then return false; end if;
      normalized_key := regexp_replace(lower(entry.key), '[^a-z0-9]', '', 'g');
      if normalized_key = any(forbidden_exact) then return false; end if;
      foreach fragment in array forbidden_fragments loop
        if strpos(normalized_key, fragment) > 0 then return false; end if;
      end loop;
      if not social_cues_private.workspace_public_tree_valid_v2(entry.item, depth + 1) then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;

create or replace function social_cues_private.workspace_projection_valid_v2(model jsonb)
returns boolean
language plpgsql
immutable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
declare
  section text;
  expected_keys constant text[] := array[
    'activity','analytics','campaigns','drafts','media','preferences','profile','providerStates','schemaVersion'
  ];
  actual_keys text[];
begin
  if jsonb_typeof(model) <> 'object'
    or octet_length(social_cues_private.workspace_canonical_json_v2(model)) > 262144
    or social_cues_private.workspace_tree_nodes_v2(model) > 10000
    or not social_cues_private.workspace_public_tree_valid_v2(model, 0) then
    return false;
  end if;

  select array_agg(key order by key) into actual_keys from jsonb_object_keys(model) as keys(key);
  if actual_keys is distinct from expected_keys
    or model->>'schemaVersion' <> 'social-cues.workspace-public.v2' then
    return false;
  end if;

  foreach section in array array['activity','campaigns','drafts','media','providerStates'] loop
    if jsonb_typeof(model->section) <> 'array'
      or exists (select 1 from jsonb_array_elements(model->section) as items(item)
        where jsonb_typeof(item) <> 'object')
      or exists (select 1 from jsonb_array_elements(model->section) as items(item)
        where item ? 'id' and (
          jsonb_typeof(item->'id') <> 'string'
          or coalesce(item->>'id', '') = ''
          or length(item->>'id') > 128
        ))
      or exists (select 1 from jsonb_array_elements(model->section) as items(item)
        where item ? 'id' group by item->>'id' having count(*) > 1) then
      return false;
    end if;
  end loop;

  foreach section in array array['analytics','preferences','profile'] loop
    if jsonb_typeof(model->section) <> 'object' then return false; end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(model->'providerStates') as states(state)
    where coalesce(state->>'provider', '') !~ '^[a-z][a-z0-9-]{0,31}$'
  ) or exists (
    select 1 from jsonb_array_elements(model->'providerStates') as states(state)
    group by state->>'provider' having count(*) > 1
  ) then
    return false;
  end if;
  return true;
end;
$$;

alter table public.workspace_members
  add column if not exists membership_status text not null default 'active';
alter table public.workspace_members alter column membership_status set default 'active';
update public.workspace_members set membership_status = 'active' where membership_status is null;
alter table public.workspace_members alter column membership_status set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspace_members'::regclass
    and conname = 'workspace_members_membership_status_check') then
    alter table public.workspace_members add constraint workspace_members_membership_status_check
      check (membership_status in ('active', 'inactive', 'removed'));
  end if;
end;
$$;

alter table public.worker_jobs
  add column if not exists workspace_persistence_lease_id uuid,
  add column if not exists workspace_persistence_intent text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.worker_jobs'::regclass
    and conname = 'worker_jobs_workspace_persistence_binding_check') then
    alter table public.worker_jobs add constraint worker_jobs_workspace_persistence_binding_check check (
      (workspace_persistence_lease_id is null and workspace_persistence_intent is null)
      or (
        workspace_persistence_lease_id is not null
        and workspace_persistence_intent in (
          'workspace.content-result','workspace.provider-state-result',
          'workspace.worker-result','workspace.system-repair'
        )
      )
    );
  end if;
end;
$$;

alter table public.workspace_models
  add column if not exists persistence_epoch uuid default gen_random_uuid(),
  add column if not exists revision numeric(128,0) default 0,
  add column if not exists content_hash text;

update public.workspace_models
set persistence_epoch = coalesce(persistence_epoch, gen_random_uuid()),
    revision = coalesce(revision, 0),
    content_hash = coalesce(content_hash, social_cues_private.workspace_canonical_hash_v2(model))
where persistence_epoch is null or revision is null or content_hash is null;

alter table public.workspace_models
  alter column persistence_epoch set default gen_random_uuid(),
  alter column persistence_epoch set not null,
  alter column revision set default 0,
  alter column revision set not null,
  alter column content_hash set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspace_models'::regclass
    and conname = 'workspace_models_revision_check') then
    alter table public.workspace_models add constraint workspace_models_revision_check
      check (revision >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspace_models'::regclass
    and conname = 'workspace_models_content_hash_format_check') then
    alter table public.workspace_models add constraint workspace_models_content_hash_format_check
      check (content_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspace_models'::regclass
    and conname = 'workspace_models_projection_check') then
    alter table public.workspace_models add constraint workspace_models_projection_check
      check (social_cues_private.workspace_projection_valid_v2(model)) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.workspace_models'::regclass
    and conname = 'workspace_models_content_hash_check') then
    alter table public.workspace_models add constraint workspace_models_content_hash_check
      check (content_hash = social_cues_private.workspace_canonical_hash_v2(model)) not valid;
  end if;
end;
$$;

create unique index if not exists workspace_models_workspace_epoch_uidx
  on public.workspace_models(workspace_id, persistence_epoch);

create table if not exists public.workspace_model_commits (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  persistence_epoch uuid not null,
  operation_id uuid not null,
  actor_user_id uuid not null,
  kind text not null check (kind in (
    'workspace.initialize','workspace.client-save','workspace.content-recovery',
    'workspace.content-result','workspace.provider-state-result',
    'workspace.worker-result','workspace.system-repair'
  )),
  expected_revision numeric(128,0),
  result_revision numeric(128,0) not null check (result_revision >= 0),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  committed_at timestamptz not null default now(),
  primary key (workspace_id, persistence_epoch, operation_id),
  constraint workspace_model_commits_expected_revision_check check (
    (kind = 'workspace.initialize' and expected_revision is null and result_revision = 0)
    or (kind <> 'workspace.initialize' and expected_revision is not null and result_revision = expected_revision + 1)
  )
);

create unique index if not exists workspace_model_commits_operation_uidx
  on public.workspace_model_commits(workspace_id, operation_id);
create unique index if not exists workspace_model_commits_result_revision_uidx
  on public.workspace_model_commits(workspace_id, persistence_epoch, result_revision);
create index if not exists workspace_model_commits_actor_idx
  on public.workspace_model_commits(workspace_id, actor_user_id, committed_at desc);

create table if not exists public.workspace_persistence_contracts (
  contract_id text primary key,
  migration_version text not null,
  interface_fingerprint text not null check (interface_fingerprint ~ '^[0-9a-f]{64}$'),
  installed_at timestamptz not null default now()
);

insert into public.workspace_persistence_contracts(contract_id, migration_version, interface_fingerprint)
values (
  'social-cues.hosted-workspace-repository.v2',
  'R4.3-P37',
  '9858768c7df3ef3e2e87c74e8692b89d3a267c869a1ad525ffcadcb423cdaef1'
)
on conflict (contract_id) do nothing;

do $$
begin
  if not exists (
    select 1 from public.workspace_persistence_contracts
    where contract_id = 'social-cues.hosted-workspace-repository.v2'
      and migration_version = 'R4.3-P37'
      and interface_fingerprint = '9858768c7df3ef3e2e87c74e8692b89d3a267c869a1ad525ffcadcb423cdaef1'
  ) then
    raise exception using errcode = '55000', message = 'workspace persistence v2 interface mismatch';
  end if;
end;
$$;

create or replace function social_cues_private.workspace_user_authorize_v2(
  target_workspace_id uuid,
  supplied_actor_user_id uuid,
  require_write boolean default false
)
returns table(owner_user_id uuid, actor_role text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  session_user_id uuid;
begin
  session_user_id := auth.uid();
  if session_user_id is null then
    perform social_cues_private.workspace_fail_v2('authentication_required');
  end if;
  if supplied_actor_user_id is null or supplied_actor_user_id <> session_user_id then
    perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
  end if;

  select workspace.owner_user_id, member.role
  into owner_user_id, actor_role
  from public.workspaces as workspace
  join public.workspace_members as member
    on member.workspace_id = workspace.id
   and member.user_id = session_user_id
   and member.membership_status = 'active'
  where workspace.id = target_workspace_id
    and workspace.owner_user_id is not null
    and member.role in ('owner','admin','member','viewer')
    and (member.role <> 'owner' or workspace.owner_user_id = session_user_id)
    and 1 = (
      select count(*) from public.billing_entitlements as entitlement
      where entitlement.workspace_id = workspace.id
        and entitlement.user_id = session_user_id
        and entitlement.status = 'active'
        and coalesce(entitlement.access, 'unpaid') <> 'unpaid'
        and (entitlement.current_period_end is null or entitlement.current_period_end > now())
    );

  if not found or (require_write and actor_role not in ('owner','admin')) then
    perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
  end if;
  return next;
end;
$$;

create or replace function social_cues_private.workspace_service_authorize_v2(
  target_workspace_id uuid,
  supplied_actor_user_id uuid,
  requested_intent text default null,
  supplied_job_id uuid default null,
  supplied_lease_id uuid default null
)
returns table(owner_user_id uuid, bound_job_id uuid, bound_lease_id uuid, allowed_intent text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  claims jsonb;
  claimed_workspace_id uuid;
  claimed_actor_user_id uuid;
  claimed_job_id uuid;
  claimed_lease_id uuid;
  claimed_intent text;
begin
  claims := social_cues_private.workspace_claims_v2();
  claimed_workspace_id := social_cues_private.workspace_safe_uuid_v2(claims->>'workspace_id');
  claimed_actor_user_id := social_cues_private.workspace_safe_uuid_v2(claims->>'actor_user_id');
  claimed_job_id := social_cues_private.workspace_safe_uuid_v2(claims->>'job_id');
  claimed_lease_id := social_cues_private.workspace_safe_uuid_v2(claims->>'lease_id');
  claimed_intent := claims->>'allowed_intent';

  if claims->>'role' <> 'service_role'
    or claims->>'context_version' <> 'social-cues.workspace-actor.v2'
    or claims->>'source' <> 'claimed-service-job'
    or claims->>'lease_status' <> 'active'
    or claimed_workspace_id is null or claimed_workspace_id <> target_workspace_id
    or claimed_actor_user_id is null or claimed_actor_user_id <> supplied_actor_user_id
    or claimed_job_id is null or claimed_lease_id is null
    or claimed_intent not in (
      'workspace.content-result','workspace.provider-state-result',
      'workspace.worker-result','workspace.system-repair'
    )
    or (requested_intent is not null and requested_intent <> claimed_intent)
    or (supplied_job_id is not null and supplied_job_id <> claimed_job_id)
    or (supplied_lease_id is not null and supplied_lease_id <> claimed_lease_id) then
    perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
  end if;

  select workspace.owner_user_id, job.id, job.workspace_persistence_lease_id, claimed_intent
  into owner_user_id, bound_job_id, bound_lease_id, allowed_intent
  from public.workspaces as workspace
  join public.workspace_members as member
    on member.workspace_id = workspace.id
   and member.user_id = claimed_actor_user_id
   and member.membership_status = 'active'
  join public.worker_jobs as job
    on job.id = claimed_job_id
   and job.workspace_id = workspace.id
   and job.user_id = claimed_actor_user_id
   and job.status = 'claimed'
   and job.lease_expires_at > now()
   and job.workspace_persistence_lease_id = claimed_lease_id
   and job.workspace_persistence_intent = claimed_intent
  where workspace.id = target_workspace_id
    and workspace.owner_user_id is not null
    and member.role in ('owner','admin','member','viewer')
    and (member.role <> 'owner' or workspace.owner_user_id = claimed_actor_user_id)
    and 1 = (
      select count(*) from public.billing_entitlements as entitlement
      where entitlement.workspace_id = workspace.id
        and entitlement.user_id = claimed_actor_user_id
        and entitlement.status = 'active'
        and coalesce(entitlement.access, 'unpaid') <> 'unpaid'
        and (entitlement.current_period_end is null or entitlement.current_period_end > now())
    );

  if not found then
    perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
  end if;
  return next;
end;
$$;

create or replace function social_cues_private.workspace_timestamp_v2(value timestamptz)
returns text
language sql
stable
strict
parallel safe
security invoker
set search_path = pg_catalog
as $$
  select to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
$$;

create or replace function social_cues_private.workspace_row_json_v2(row_value public.workspace_models)
returns jsonb
language plpgsql
stable
strict
security definer
set search_path = pg_catalog, public
as $$
begin
  if not social_cues_private.workspace_projection_valid_v2(row_value.model)
    or row_value.content_hash <> social_cues_private.workspace_canonical_hash_v2(row_value.model) then
    perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable');
  end if;
  return jsonb_build_object(
    'content_hash', row_value.content_hash,
    'created_at', social_cues_private.workspace_timestamp_v2(row_value.created_at),
    'model', row_value.model,
    'owner_user_id', row_value.owner_user_id::text,
    'persistence_epoch', row_value.persistence_epoch::text,
    'revision', row_value.revision::text,
    'updated_at', social_cues_private.workspace_timestamp_v2(row_value.updated_at),
    'workspace_id', row_value.workspace_id::text
  );
end;
$$;

create or replace function social_cues_private.workspace_receipt_json_v2(row_value public.workspace_model_commits)
returns jsonb
language sql
stable
strict
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'actor_user_id', row_value.actor_user_id::text,
    'committed_at', social_cues_private.workspace_timestamp_v2(row_value.committed_at),
    'content_hash', row_value.content_hash,
    'expected_revision', case when row_value.expected_revision is null then null else row_value.expected_revision::text end,
    'kind', row_value.kind,
    'operation_id', row_value.operation_id::text,
    'persistence_epoch', row_value.persistence_epoch::text,
    'request_hash', row_value.request_hash,
    'result_revision', row_value.result_revision::text,
    'workspace_id', row_value.workspace_id::text
  );
$$;

create or replace function social_cues_private.workspace_receipt_matches_v2(
  receipt public.workspace_model_commits,
  supplied_actor_user_id uuid,
  supplied_kind text,
  supplied_expected_epoch uuid,
  supplied_expected_revision numeric,
  supplied_request_hash text,
  supplied_content_hash text default null
)
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = pg_catalog, public
as $$
  select receipt.actor_user_id = supplied_actor_user_id
    and receipt.kind = supplied_kind
    and receipt.expected_revision is not distinct from supplied_expected_revision
    and receipt.request_hash = supplied_request_hash
    and (supplied_content_hash is null or receipt.content_hash = supplied_content_hash)
    and (
      (supplied_kind = 'workspace.initialize' and supplied_expected_epoch is null)
      or receipt.persistence_epoch = supplied_expected_epoch
    );
$$;

create or replace function public.social_cues_workspace_read_v2(workspace_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, social_cues_private
as $$
declare
  target_workspace_id uuid;
  target_actor_user_id uuid;
  owner_id uuid;
  stored public.workspace_models%rowtype;
  claims jsonb;
begin
  target_workspace_id := social_cues_private.workspace_safe_uuid_v2(workspace_id);
  if target_workspace_id is null then perform social_cues_private.workspace_fail_v2('workspace_input_invalid'); end if;
  claims := social_cues_private.workspace_claims_v2();

  if claims->>'role' = 'service_role' then
    target_actor_user_id := social_cues_private.workspace_safe_uuid_v2(claims->>'actor_user_id');
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_service_authorize_v2(target_workspace_id, target_actor_user_id) as authorized;
  else
    target_actor_user_id := auth.uid();
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_user_authorize_v2(target_workspace_id, target_actor_user_id, false) as authorized;
  end if;

  select model_row.* into stored from public.workspace_models as model_row
  where model_row.workspace_id = target_workspace_id;
  if not found then return jsonb_build_object('outcome','absent','rows','[]'::jsonb); end if;
  if stored.owner_user_id <> owner_id then perform social_cues_private.workspace_fail_v2('workspace_authorization_failed'); end if;
  return jsonb_build_object('outcome','present','rows',jsonb_build_array(
    social_cues_private.workspace_row_json_v2(stored)
  ));
exception
  when sqlstate 'PT400' or sqlstate 'PT401' or sqlstate 'PT403' or sqlstate 'PT409'
    or sqlstate 'PT428' or sqlstate 'PT503' then raise;
  when others then perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable'); return null;
end;
$$;

create or replace function public.social_cues_workspace_initialize_v2(
  actor_user_id text,
  content_hash text,
  kind text,
  model jsonb,
  operation_id text,
  request_hash text,
  workspace_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth, social_cues_private
as $$
declare
  target_workspace_id uuid;
  target_actor_user_id uuid;
  target_operation_id uuid;
  owner_id uuid;
  stored public.workspace_models%rowtype;
  prior public.workspace_model_commits%rowtype;
  committed public.workspace_model_commits%rowtype;
begin
  target_workspace_id := social_cues_private.workspace_safe_uuid_v2(workspace_id);
  target_actor_user_id := social_cues_private.workspace_safe_uuid_v2(actor_user_id);
  target_operation_id := social_cues_private.workspace_safe_uuid_v2(operation_id);
  if target_workspace_id is null or target_actor_user_id is null or target_operation_id is null
    or operation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or kind <> 'workspace.initialize'
    or not social_cues_private.workspace_hash_valid_v2(content_hash)
    or not social_cues_private.workspace_hash_valid_v2(request_hash)
    or model is null
    or not social_cues_private.workspace_projection_valid_v2(model)
    or content_hash <> social_cues_private.workspace_canonical_hash_v2(model) then
    perform social_cues_private.workspace_fail_v2('workspace_input_invalid');
  end if;

  select authorized.owner_user_id into owner_id
  from social_cues_private.workspace_user_authorize_v2(target_workspace_id, target_actor_user_id, true) as authorized;
  perform 1 from public.workspaces where id = target_workspace_id for update;

  select receipt.* into prior from public.workspace_model_commits as receipt
  where receipt.workspace_id = target_workspace_id and receipt.operation_id = target_operation_id;
  if found then
    if not social_cues_private.workspace_receipt_matches_v2(
      prior, target_actor_user_id, kind, null, null, request_hash, content_hash
    ) then
      perform social_cues_private.workspace_fail_v2('workspace_operation_id_reused');
    end if;
    select model_row.* into stored from public.workspace_models as model_row
      where model_row.workspace_id = target_workspace_id;
    if not found or stored.owner_user_id <> owner_id then
      perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable');
    end if;
    return jsonb_build_object('outcome','replayed',
      'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
      'receipts',jsonb_build_array(social_cues_private.workspace_receipt_json_v2(prior)));
  end if;

  select model_row.* into stored from public.workspace_models as model_row
    where model_row.workspace_id = target_workspace_id;
  if found then
    if stored.owner_user_id <> owner_id then perform social_cues_private.workspace_fail_v2('workspace_authorization_failed'); end if;
    return jsonb_build_object('outcome','existing',
      'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
      'receipts','[]'::jsonb);
  end if;

  insert into public.workspace_models(workspace_id, owner_user_id, model, persistence_epoch, revision, content_hash)
  values (target_workspace_id, owner_id, model, gen_random_uuid(), 0, content_hash)
  returning * into stored;
  insert into public.workspace_model_commits(
    workspace_id,persistence_epoch,operation_id,actor_user_id,kind,expected_revision,
    result_revision,request_hash,content_hash
  ) values (
    target_workspace_id,stored.persistence_epoch,target_operation_id,target_actor_user_id,kind,null,
    0,request_hash,content_hash
  ) returning * into committed;
  return jsonb_build_object('outcome','committed',
    'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
    'receipts',jsonb_build_array(social_cues_private.workspace_receipt_json_v2(committed)));
exception
  when sqlstate 'PT400' or sqlstate 'PT401' or sqlstate 'PT403' or sqlstate 'PT409'
    or sqlstate 'PT428' or sqlstate 'PT503' then raise;
  when others then perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable'); return null;
end;
$$;

create or replace function public.social_cues_workspace_commit_v2(
  actor_user_id text,
  content_hash text,
  expected_epoch text,
  expected_revision text,
  kind text,
  model jsonb,
  operation_id text,
  request_hash text,
  workspace_id text,
  job_id text default null,
  lease_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, auth, social_cues_private
as $$
declare
  target_workspace_id uuid;
  target_actor_user_id uuid;
  target_operation_id uuid;
  target_epoch uuid;
  target_expected_revision numeric(128,0);
  target_job_id uuid;
  target_lease_id uuid;
  owner_id uuid;
  stored public.workspace_models%rowtype;
  prior public.workspace_model_commits%rowtype;
  committed public.workspace_model_commits%rowtype;
  claims jsonb;
begin
  target_workspace_id := social_cues_private.workspace_safe_uuid_v2(workspace_id);
  target_actor_user_id := social_cues_private.workspace_safe_uuid_v2(actor_user_id);
  target_operation_id := social_cues_private.workspace_safe_uuid_v2(operation_id);
  target_epoch := social_cues_private.workspace_safe_uuid_v2(expected_epoch);
  target_job_id := social_cues_private.workspace_safe_uuid_v2(job_id);
  target_lease_id := social_cues_private.workspace_safe_uuid_v2(lease_id);
  if expected_revision is null then perform social_cues_private.workspace_fail_v2('workspace_revision_required'); end if;
  if not social_cues_private.workspace_revision_valid_v2(expected_revision) then
    perform social_cues_private.workspace_fail_v2('workspace_input_invalid');
  end if;
  target_expected_revision := expected_revision::numeric(128,0);
  if target_workspace_id is null or target_actor_user_id is null or target_operation_id is null or target_epoch is null
    or operation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or kind not in (
      'workspace.client-save','workspace.content-recovery','workspace.content-result',
      'workspace.provider-state-result','workspace.worker-result','workspace.system-repair'
    )
    or not social_cues_private.workspace_hash_valid_v2(content_hash)
    or not social_cues_private.workspace_hash_valid_v2(request_hash)
    or model is null
    or not social_cues_private.workspace_projection_valid_v2(model)
    or content_hash <> social_cues_private.workspace_canonical_hash_v2(model) then
    perform social_cues_private.workspace_fail_v2('workspace_input_invalid');
  end if;

  claims := social_cues_private.workspace_claims_v2();
  if claims->>'role' = 'service_role' then
    if target_job_id is null or target_lease_id is null then
      perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
    end if;
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_service_authorize_v2(
      target_workspace_id,target_actor_user_id,kind,target_job_id,target_lease_id
    ) as authorized;
  else
    if job_id is not null or lease_id is not null
      or kind not in ('workspace.client-save','workspace.content-recovery') then
      perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
    end if;
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_user_authorize_v2(target_workspace_id,target_actor_user_id,true) as authorized;
  end if;

  select model_row.* into stored from public.workspace_models as model_row
  where model_row.workspace_id = target_workspace_id for update;
  if not found or stored.owner_user_id <> owner_id then
    perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable');
  end if;

  select receipt.* into prior from public.workspace_model_commits as receipt
  where receipt.workspace_id = target_workspace_id and receipt.operation_id = target_operation_id;
  if found then
    if not social_cues_private.workspace_receipt_matches_v2(
      prior,target_actor_user_id,kind,target_epoch,target_expected_revision,request_hash,content_hash
    ) then
      perform social_cues_private.workspace_fail_v2('workspace_operation_id_reused');
    end if;
    return jsonb_build_object('outcome','replayed',
      'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
      'receipts',jsonb_build_array(social_cues_private.workspace_receipt_json_v2(prior)));
  end if;

  if stored.persistence_epoch <> target_epoch or stored.revision <> target_expected_revision then
    perform social_cues_private.workspace_fail_v2('workspace_revision_conflict');
  end if;
  if stored.revision >= (repeat('9',128))::numeric then
    perform social_cues_private.workspace_fail_v2('workspace_revision_conflict');
  end if;

  update public.workspace_models as model_row
  set model = social_cues_workspace_commit_v2.model,
      revision = model_row.revision + 1,
      content_hash = social_cues_workspace_commit_v2.content_hash,
      updated_at = now()
  where model_row.workspace_id = target_workspace_id
    and model_row.persistence_epoch = target_epoch
    and model_row.revision = target_expected_revision
  returning model_row.* into stored;
  if not found then perform social_cues_private.workspace_fail_v2('workspace_revision_conflict'); end if;

  insert into public.workspace_model_commits(
    workspace_id,persistence_epoch,operation_id,actor_user_id,kind,expected_revision,
    result_revision,request_hash,content_hash
  ) values (
    target_workspace_id,target_epoch,target_operation_id,target_actor_user_id,kind,target_expected_revision,
    stored.revision,request_hash,content_hash
  ) returning * into committed;
  return jsonb_build_object('outcome','committed',
    'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
    'receipts',jsonb_build_array(social_cues_private.workspace_receipt_json_v2(committed)));
exception
  when sqlstate 'PT400' or sqlstate 'PT401' or sqlstate 'PT403' or sqlstate 'PT409'
    or sqlstate 'PT428' or sqlstate 'PT503' then raise;
  when others then perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable'); return null;
end;
$$;

create or replace function public.social_cues_workspace_receipt_v2(
  actor_user_id text,
  expected_epoch text,
  expected_revision text,
  kind text,
  operation_id text,
  request_hash text,
  workspace_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, social_cues_private
as $$
declare
  target_workspace_id uuid;
  target_actor_user_id uuid;
  target_operation_id uuid;
  target_epoch uuid;
  target_expected_revision numeric(128,0);
  owner_id uuid;
  stored public.workspace_models%rowtype;
  prior public.workspace_model_commits%rowtype;
  claims jsonb;
begin
  target_workspace_id := social_cues_private.workspace_safe_uuid_v2(workspace_id);
  target_actor_user_id := social_cues_private.workspace_safe_uuid_v2(actor_user_id);
  target_operation_id := social_cues_private.workspace_safe_uuid_v2(operation_id);
  target_epoch := social_cues_private.workspace_safe_uuid_v2(expected_epoch);
  if target_workspace_id is null or target_actor_user_id is null or target_operation_id is null
    or operation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or kind not in (
      'workspace.initialize','workspace.client-save','workspace.content-recovery',
      'workspace.content-result','workspace.provider-state-result',
      'workspace.worker-result','workspace.system-repair'
    )
    or not social_cues_private.workspace_hash_valid_v2(request_hash)
    or (kind = 'workspace.initialize' and (expected_epoch is not null or expected_revision is not null))
    or (kind <> 'workspace.initialize' and (
      target_epoch is null or not social_cues_private.workspace_revision_valid_v2(expected_revision)
    )) then
    perform social_cues_private.workspace_fail_v2('workspace_input_invalid');
  end if;
  if kind <> 'workspace.initialize' then target_expected_revision := expected_revision::numeric(128,0); end if;

  claims := social_cues_private.workspace_claims_v2();
  if claims->>'role' = 'service_role' then
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_service_authorize_v2(
      target_workspace_id,target_actor_user_id,kind
    ) as authorized;
  else
    if kind not in ('workspace.initialize','workspace.client-save','workspace.content-recovery') then
      perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
    end if;
    select authorized.owner_user_id into owner_id
    from social_cues_private.workspace_user_authorize_v2(target_workspace_id,target_actor_user_id,false) as authorized;
  end if;

  select model_row.* into stored from public.workspace_models as model_row
    where model_row.workspace_id = target_workspace_id;
  if found and stored.owner_user_id <> owner_id then
    perform social_cues_private.workspace_fail_v2('workspace_authorization_failed');
  end if;

  select receipt.* into prior from public.workspace_model_commits as receipt
  where receipt.workspace_id = target_workspace_id and receipt.operation_id = target_operation_id;
  if found then
    if not social_cues_private.workspace_receipt_matches_v2(
      prior,target_actor_user_id,kind,target_epoch,target_expected_revision,request_hash,null
    ) then
      perform social_cues_private.workspace_fail_v2('workspace_operation_id_reused');
    end if;
    if stored.workspace_id is null then perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable'); end if;
    return jsonb_build_object('outcome','replayed',
      'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
      'receipts',jsonb_build_array(social_cues_private.workspace_receipt_json_v2(prior)));
  end if;

  if stored.workspace_id is null then
    return jsonb_build_object('outcome','absent','rows','[]'::jsonb,'receipts','[]'::jsonb);
  end if;
  return jsonb_build_object(
    'outcome',case when kind = 'workspace.initialize' then 'existing' else 'not_found' end,
    'rows',jsonb_build_array(social_cues_private.workspace_row_json_v2(stored)),
    'receipts','[]'::jsonb
  );
exception
  when sqlstate 'PT400' or sqlstate 'PT401' or sqlstate 'PT403' or sqlstate 'PT409'
    or sqlstate 'PT428' or sqlstate 'PT503' then raise;
  when others then perform social_cues_private.workspace_fail_v2('workspace_storage_unavailable'); return null;
end;
$$;

create or replace function public.social_cues_workspace_persistence_fingerprint_v2()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select interface_fingerprint from public.workspace_persistence_contracts
  where contract_id = 'social-cues.hosted-workspace-repository.v2';
$$;

alter table public.workspace_models enable row level security;
alter table public.workspace_models force row level security;
alter table public.workspace_model_commits enable row level security;
alter table public.workspace_model_commits force row level security;
alter table public.workspace_persistence_contracts enable row level security;
alter table public.workspace_persistence_contracts force row level security;

drop policy if exists "users can read own workspace model" on public.workspace_models;
drop policy if exists "users can insert own workspace model" on public.workspace_models;
drop policy if exists "users can update own workspace model" on public.workspace_models;
drop policy if exists "workspace models require persistence RPC" on public.workspace_models;
create policy "workspace models require persistence RPC" on public.workspace_models
  for all to anon, authenticated, service_role using (false) with check (false);
drop policy if exists "workspace model commits are private" on public.workspace_model_commits;
create policy "workspace model commits are private" on public.workspace_model_commits
  for all to anon, authenticated, service_role using (false) with check (false);
drop policy if exists "workspace persistence contracts are private" on public.workspace_persistence_contracts;
create policy "workspace persistence contracts are private" on public.workspace_persistence_contracts
  for all to anon, authenticated, service_role using (false) with check (false);

revoke all on table public.workspace_models from public, anon, authenticated, service_role;
revoke all on table public.workspace_model_commits from public, anon, authenticated, service_role;
revoke all on table public.workspace_persistence_contracts from public, anon, authenticated, service_role;

revoke all on all functions in schema social_cues_private from public, anon, authenticated, service_role;
revoke all on function public.social_cues_workspace_read_v2(text) from public, anon, authenticated, service_role;
revoke all on function public.social_cues_workspace_initialize_v2(text,text,text,jsonb,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.social_cues_workspace_commit_v2(text,text,text,text,text,jsonb,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.social_cues_workspace_receipt_v2(text,text,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.social_cues_workspace_persistence_fingerprint_v2() from public, anon, authenticated, service_role;

grant execute on function public.social_cues_workspace_read_v2(text) to authenticated, service_role;
grant execute on function public.social_cues_workspace_initialize_v2(text,text,text,jsonb,text,text,text) to authenticated;
grant execute on function public.social_cues_workspace_commit_v2(text,text,text,text,text,jsonb,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.social_cues_workspace_receipt_v2(text,text,text,text,text,text,text) to authenticated, service_role;
grant execute on function public.social_cues_workspace_persistence_fingerprint_v2() to service_role;

alter function public.social_cues_workspace_read_v2(text) owner to postgres;
alter function public.social_cues_workspace_initialize_v2(text,text,text,jsonb,text,text,text) owner to postgres;
alter function public.social_cues_workspace_commit_v2(text,text,text,text,text,jsonb,text,text,text,text,text) owner to postgres;
alter function public.social_cues_workspace_receipt_v2(text,text,text,text,text,text,text) owner to postgres;
alter function public.social_cues_workspace_persistence_fingerprint_v2() owner to postgres;


create policy "users can update own media objects"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'social-cues-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'social-cues-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- BEGIN SOCIAL CUES HEYGEN DURABLE PERSISTENCE (exact standalone migration)
-- Social Cues durable HeyGen OAuth, account, job, and immutable lineage boundary.
-- Additive, rerunnable R4.9 migration. Apply only after review; never store raw
-- OAuth state, authorization codes, plaintext tokens, or provider response bodies.

begin;

create extension if not exists pgcrypto;
create schema if not exists social_cues_private;

alter table public.workspace_members
  add column if not exists membership_status text not null default 'active';

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

alter table public.media_assets
  add column if not exists owner_user_id uuid,
  add column if not exists status text,
  add column if not exists content_type text,
  add column if not exists provider_resource_id text,
  add column if not exists source_asset_id uuid,
  add column if not exists parent_asset_id uuid,
  add column if not exists root_asset_id uuid,
  add column if not exists version_number integer,
  add column if not exists immutable boolean not null default false,
  add column if not exists provider_session_id text,
  add column if not exists provider_job_id text,
  add column if not exists operation_id text,
  add column if not exists updated_at timestamptz not null default now();

create table if not exists social_cues_private.heygen_oauth_states (
  state_digest text primary key,
  provider text not null default 'heygen' check (provider = 'heygen'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null,
  protected_verifier jsonb,
  discovered_metadata jsonb,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  connected_account_id uuid references public.connected_accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (state_digest ~ '^[A-Za-z0-9_-]{43}$'),
  check (expires_at > issued_at),
  check (not (completed_at is not null and cancelled_at is not null))
);

create table if not exists social_cues_private.heygen_operation_receipts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_user_id uuid not null,
  provider text not null default 'heygen' check (provider = 'heygen'),
  operation_kind text not null check (operation_kind in ('refresh', 'disconnect')),
  operation_id text not null,
  request_fingerprint text not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  safe_result jsonb not null default '{}'::jsonb,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (workspace_id, provider, operation_kind, operation_id),
  check (pg_catalog.length(operation_id) <= 500 and operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  check (request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  check (octet_length(safe_result::text) <= 4096)
);

create table if not exists public.heygen_media_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requesting_user_id uuid not null,
  connected_account_id uuid not null,
  provider text not null default 'heygen' check (provider = 'heygen'),
  action text not null check (action in (
    'prompt_to_video', 'revise_video', 'create_variant', 'avatar_video',
    'template_video', 'replace_audio', 'translate_video', 'remove_fillers'
  )),
  operation_id text not null,
  request_fingerprint text not null,
  request_arguments jsonb not null default '{}'::jsonb,
  result_fingerprint text,
  status text not null default 'submitted' check (status in ('submitted', 'processing', 'completed', 'failed')),
  provider_job_id text,
  provider_session_id text,
  capability_id text,
  capability_tool_name text,
  source_asset_id uuid references public.media_assets(id) on delete no action deferrable initially deferred,
  parent_asset_id uuid references public.media_assets(id) on delete no action deferrable initially deferred,
  root_asset_id uuid references public.media_assets(id) on delete no action deferrable initially deferred,
  output_asset_id uuid references public.media_assets(id) on delete no action deferrable initially deferred,
  failure_code text,
  public_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, provider, operation_id),
  check (pg_catalog.length(operation_id) <= 500 and operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  check (request_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  check (result_fingerprint is null or result_fingerprint ~ '^[A-Za-z0-9_-]{43}$'),
  check (jsonb_typeof(request_arguments) = 'object'),
  check (octet_length(request_arguments::text) <= 16384),
  check (provider_job_id is null or length(provider_job_id) <= 500),
  check (provider_session_id is null or length(provider_session_id) <= 500),
  check (failure_code is null or length(failure_code) <= 100),
  check (public_message is null or length(public_message) <= 500)
);

alter table public.heygen_media_jobs
  alter constraint heygen_media_jobs_source_asset_id_fkey deferrable initially deferred,
  alter constraint heygen_media_jobs_parent_asset_id_fkey deferrable initially deferred,
  alter constraint heygen_media_jobs_root_asset_id_fkey deferrable initially deferred,
  alter constraint heygen_media_jobs_output_asset_id_fkey deferrable initially deferred;

do $migration_guard$
begin
  if exists (
    select 1
    from public.connected_accounts ca
    where ca.provider = 'heygen' or ca.platform = 'heygen'
    group by ca.workspace_id
    having count(*) > 1
  ) or exists (
    select 1 from public.connected_accounts ca
    where (ca.provider = 'heygen' or ca.platform = 'heygen')
      and not (ca.provider = 'heygen' and ca.platform = 'heygen')
  ) then
    raise exception using errcode = '23514', message = 'HEYGEN_MIGRATION_REQUIRES_ACCOUNT_CLEANUP';
  end if;
end;
$migration_guard$;

create unique index if not exists connected_accounts_workspace_heygen_uidx
  on public.connected_accounts(workspace_id)
  where provider = 'heygen' and platform = 'heygen';
create index if not exists connected_accounts_heygen_owner_idx
  on public.connected_accounts(workspace_id, user_id)
  where provider = 'heygen' and platform = 'heygen';
create index if not exists provider_tokens_heygen_account_idx
  on public.provider_tokens(connected_account_id, workspace_id)
  where provider = 'heygen';
create index if not exists heygen_oauth_states_owner_expiry_idx
  on social_cues_private.heygen_oauth_states(workspace_id, actor_user_id, expires_at);
create index if not exists heygen_oauth_states_terminal_cleanup_idx
  on social_cues_private.heygen_oauth_states(expires_at, completed_at, cancelled_at);
create index if not exists heygen_operation_receipts_owner_status_idx
  on social_cues_private.heygen_operation_receipts(workspace_id, actor_user_id, status, updated_at);
create index if not exists heygen_media_jobs_owner_poll_idx
  on public.heygen_media_jobs(workspace_id, requesting_user_id, status, updated_at desc);
create index if not exists heygen_media_jobs_terminal_cleanup_idx
  on public.heygen_media_jobs(completed_at)
  where status in ('completed', 'failed');
create index if not exists heygen_media_jobs_lineage_idx
  on public.heygen_media_jobs(workspace_id, root_asset_id, created_at);
create index if not exists heygen_media_jobs_source_idx
  on public.heygen_media_jobs(source_asset_id)
  where source_asset_id is not null;
create index if not exists heygen_media_jobs_parent_idx
  on public.heygen_media_jobs(parent_asset_id)
  where parent_asset_id is not null;
create index if not exists heygen_media_jobs_root_idx
  on public.heygen_media_jobs(root_asset_id)
  where root_asset_id is not null;
create index if not exists heygen_media_jobs_output_idx
  on public.heygen_media_jobs(output_asset_id)
  where output_asset_id is not null;
create index if not exists media_assets_heygen_owner_idx
  on public.media_assets(workspace_id, owner_user_id, created_at desc)
  where provider = 'heygen';
create unique index if not exists media_assets_heygen_operation_uidx
  on public.media_assets(workspace_id, provider, operation_id)
  where provider = 'heygen' and operation_id is not null;
create unique index if not exists media_assets_heygen_root_version_uidx
  on public.media_assets(workspace_id, root_asset_id, version_number)
  where provider = 'heygen' and root_asset_id is not null and version_number is not null;
create index if not exists media_assets_heygen_parent_idx
  on public.media_assets(parent_asset_id)
  where provider = 'heygen' and parent_asset_id is not null;
create index if not exists media_assets_heygen_source_idx
  on public.media_assets(source_asset_id)
  where provider = 'heygen' and source_asset_id is not null;
create index if not exists media_assets_heygen_root_idx
  on public.media_assets(root_asset_id)
  where provider = 'heygen' and root_asset_id is not null;

do $lineage_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.media_assets'::pg_catalog.regclass
      and conname = 'media_assets_heygen_source_asset_fkey'
  ) then
    alter table public.media_assets
      add constraint media_assets_heygen_source_asset_fkey
      foreign key (source_asset_id) references public.media_assets(id)
      on delete no action deferrable initially deferred not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.media_assets'::pg_catalog.regclass
      and conname = 'media_assets_heygen_parent_asset_fkey'
  ) then
    alter table public.media_assets
      add constraint media_assets_heygen_parent_asset_fkey
      foreign key (parent_asset_id) references public.media_assets(id)
      on delete no action deferrable initially deferred not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.media_assets'::pg_catalog.regclass
      and conname = 'media_assets_heygen_root_asset_fkey'
  ) then
    alter table public.media_assets
      add constraint media_assets_heygen_root_asset_fkey
      foreign key (root_asset_id) references public.media_assets(id)
      on delete no action deferrable initially deferred not valid;
  end if;
end;
$lineage_constraints$;

alter table public.media_assets validate constraint media_assets_heygen_source_asset_fkey;
alter table public.media_assets validate constraint media_assets_heygen_parent_asset_fkey;
alter table public.media_assets validate constraint media_assets_heygen_root_asset_fkey;

create or replace function social_cues_private.heygen_assert_service_role()
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_jwt_role text := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
begin
  if current_user <> 'service_role' or (v_jwt_role is not null and v_jwt_role <> 'service_role') then
    raise exception using errcode = '42501', message = 'HEYGEN_SERVICE_ROLE_REQUIRED';
  end if;
end;
$function$;

create or replace function social_cues_private.heygen_assert_access(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns void
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_role text;
begin
  perform social_cues_private.heygen_assert_service_role();
  select lower(wm.role)
  into v_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = p_actor_user_id
    and coalesce(wm.membership_status, 'active') = 'active';

  if v_role is null then
    raise exception using errcode = '42501', message = 'HEYGEN_NOT_AUTHORIZED';
  end if;

  if not exists (
    select 1
    from public.billing_entitlements be
    where be.workspace_id = p_workspace_id
      and be.user_id = p_actor_user_id
      and be.status = 'active'
      and coalesce(be.access, 'unpaid') <> 'unpaid'
      and (be.current_period_end is null or be.current_period_end > pg_catalog.now())
  ) then
    raise exception using errcode = '42501', message = 'HEYGEN_NOT_AUTHORIZED';
  end if;
end;
$function$;

create or replace function social_cues_private.heygen_valid_envelope(p_value jsonb)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $function$
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'object'
    and p_value = pg_catalog.jsonb_strip_nulls(p_value)
    and p_value ?& array['alg', 'iv', 'tag', 'value']
    and (p_value - array['alg', 'iv', 'tag', 'value']) = '{}'::jsonb
    and p_value->>'alg' = 'aes-256-gcm'
    and p_value->>'iv' ~ '^[A-Za-z0-9_-]{16}$'
    and p_value->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    and pg_catalog.length(p_value->>'value') between 1 and 4096
    and p_value->>'value' ~ '^[A-Za-z0-9_-]+$';
$function$;

create or replace function social_cues_private.heygen_valid_metadata(p_value jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_value jsonb;
begin
  if p_value is null
    or pg_catalog.jsonb_typeof(p_value) <> 'object'
    or pg_catalog.octet_length(p_value::text) > 16384
    or not (p_value ?& array[
      'resource', 'issuer', 'authorizationEndpoint', 'tokenEndpoint',
      'registrationEndpoint', 'revocationEndpoint', 'scopesSupported',
      'tokenEndpointAuthMethods'
    ])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_value) key
      where key not in (
        'resource', 'issuer', 'authorizationEndpoint', 'tokenEndpoint',
        'registrationEndpoint', 'revocationEndpoint', 'scopesSupported',
        'tokenEndpointAuthMethods'
      )
    ) then
    return false;
  end if;

  if p_value->>'resource' <> 'https://mcp.heygen.com/mcp/v1/'
    or pg_catalog.jsonb_typeof(p_value->'issuer') <> 'string'
    or pg_catalog.jsonb_typeof(p_value->'authorizationEndpoint') <> 'string'
    or pg_catalog.jsonb_typeof(p_value->'tokenEndpoint') <> 'string'
    or (p_value->'registrationEndpoint' <> 'null'::jsonb
      and pg_catalog.jsonb_typeof(p_value->'registrationEndpoint') <> 'string')
    or (p_value->'revocationEndpoint' <> 'null'::jsonb
      and pg_catalog.jsonb_typeof(p_value->'revocationEndpoint') <> 'string')
    or pg_catalog.jsonb_typeof(p_value->'scopesSupported') <> 'array'
    or pg_catalog.jsonb_array_length(p_value->'scopesSupported') > 50
    or pg_catalog.jsonb_typeof(p_value->'tokenEndpointAuthMethods') <> 'array'
    or pg_catalog.jsonb_array_length(p_value->'tokenEndpointAuthMethods') > 20 then
    return false;
  end if;

  foreach v_value in array array[
    p_value->'issuer',
    p_value->'authorizationEndpoint',
    p_value->'tokenEndpoint',
    p_value->'registrationEndpoint',
    p_value->'revocationEndpoint'
  ] loop
    if v_value <> 'null'::jsonb and (
      pg_catalog.octet_length(v_value #>> '{}') > 2000
      or (v_value #>> '{}') !~ '^https://([A-Za-z0-9-]+[.])*heygen[.]com(:443)?(/[^[:space:]]*)?$'
    ) then
      return false;
    end if;
  end loop;

  for v_value in
    select value from pg_catalog.jsonb_array_elements(p_value->'scopesSupported')
    union all
    select value from pg_catalog.jsonb_array_elements(p_value->'tokenEndpointAuthMethods')
  loop
    if pg_catalog.jsonb_typeof(v_value) <> 'string'
      or nullif(pg_catalog.btrim(v_value #>> '{}'), '') is null
      or pg_catalog.octet_length(v_value #>> '{}') > 200 then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

create or replace function social_cues_private.heygen_valid_public_profile(p_value jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_entry jsonb;
begin
  if p_value is null
    or pg_catalog.jsonb_typeof(p_value) <> 'object'
    or pg_catalog.octet_length(p_value::text) > 32768
    or not (p_value ?& array[
      'plan', 'credits', 'advertisedTools', 'capabilities',
      'oauthMetadata', 'billingRelationship'
    ])
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_value) key
      where key not in (
        'plan', 'credits', 'advertisedTools', 'capabilities',
        'oauthMetadata', 'billingRelationship'
      )
    ) then
    return false;
  end if;

  if p_value->>'billingRelationship' <> 'customer-owned-heygen-plan'
    or pg_catalog.jsonb_typeof(p_value->'plan') <> 'string'
    or pg_catalog.octet_length(p_value->>'plan') > 200
    or pg_catalog.jsonb_typeof(p_value->'credits') <> 'object'
    or exists (
      select 1 from pg_catalog.jsonb_object_keys(p_value->'credits') key
      where key not in ('available', 'remaining')
    )
    or not (p_value->'credits' ?& array['available', 'remaining'])
    or pg_catalog.jsonb_typeof(p_value->'credits'->'available') not in ('boolean', 'null')
    or pg_catalog.jsonb_typeof(p_value->'credits'->'remaining') not in ('number', 'null')
    or pg_catalog.jsonb_typeof(p_value->'advertisedTools') <> 'array'
    or pg_catalog.jsonb_array_length(p_value->'advertisedTools') > 100
    or pg_catalog.jsonb_typeof(p_value->'capabilities') <> 'array'
    or pg_catalog.jsonb_array_length(p_value->'capabilities') > 100
    or not social_cues_private.heygen_valid_metadata(p_value->'oauthMetadata') then
    return false;
  end if;

  for v_entry in select value from pg_catalog.jsonb_array_elements(p_value->'advertisedTools') loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ? 'name')
      or (v_entry - 'name') <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(v_entry->'name') <> 'string'
      or nullif(pg_catalog.btrim(v_entry->>'name'), '') is null
      or pg_catalog.octet_length(v_entry->>'name') > 160 then
      return false;
    end if;
  end loop;

  for v_entry in select value from pg_catalog.jsonb_array_elements(p_value->'capabilities') loop
    if pg_catalog.jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array['id', 'label', 'toolName'])
      or (v_entry - array['id', 'label', 'toolName']) <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(v_entry->'id') <> 'string'
      or pg_catalog.jsonb_typeof(v_entry->'label') <> 'string'
      or pg_catalog.jsonb_typeof(v_entry->'toolName') <> 'string'
      or (v_entry->>'id') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      or (v_entry->>'toolName') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
      or pg_catalog.octet_length(v_entry->>'id') > 120
      or pg_catalog.octet_length(v_entry->>'label') > 200
      or pg_catalog.octet_length(v_entry->>'toolName') > 200 then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

create or replace function social_cues_private.heygen_valid_request_arguments(
  p_action text,
  p_value jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_allowed_keys text[];
  v_entry record;
begin
  if p_value is null
    or pg_catalog.jsonb_typeof(p_value) <> 'object'
    or pg_catalog.octet_length(p_value::text) > 16384
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_value)) > 11 then
    return false;
  end if;

  v_allowed_keys := case pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')))
    when 'prompt_to_video' then array['prompt', 'title', 'brandKitId']
    when 'revise_video' then array['prompt', 'sessionId', 'sourceAssetId', 'parentVersionId']
    when 'create_variant' then array['prompt', 'sessionId', 'sourceAssetId', 'parentVersionId']
    when 'avatar_video' then array['prompt', 'avatarId', 'imageAssetId', 'voiceId', 'title']
    when 'template_video' then array['templateId', 'prompt', 'title', 'voiceId']
    when 'replace_audio' then array['sourceAssetId', 'audioAssetId', 'voiceId', 'parentVersionId']
    when 'translate_video' then array['sourceAssetId', 'locale', 'glossaryId', 'parentVersionId']
    when 'remove_fillers' then array['sourceAssetId', 'parentVersionId']
    else null
  end;
  if v_allowed_keys is null then return false; end if;

  for v_entry in select key, value from pg_catalog.jsonb_each(p_value) loop
    if not (v_entry.key = any(v_allowed_keys))
      or pg_catalog.jsonb_typeof(v_entry.value) not in ('string', 'number', 'boolean', 'null')
      or (
        pg_catalog.jsonb_typeof(v_entry.value) = 'string'
        and pg_catalog.octet_length(v_entry.value #>> '{}') > 8192
      ) then
      return false;
    end if;
  end loop;
  return true;
end;
$function$;

create or replace function social_cues_private.heygen_valid_operation_safe_result(p_value jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
declare
  v_revocation jsonb;
  v_attempted boolean;
  v_state text;
begin
  if p_value is null
    or pg_catalog.jsonb_typeof(p_value) <> 'object'
    or pg_catalog.octet_length(p_value::text) > 4096 then
    return false;
  end if;

  if p_value = '{}'::jsonb or p_value = '{"refreshed": true}'::jsonb then
    return true;
  end if;

  if p_value ? 'failureCode'
    and (p_value - 'failureCode') = '{}'::jsonb
    and pg_catalog.jsonb_typeof(p_value->'failureCode') = 'string'
    and pg_catalog.length(p_value->>'failureCode') between 1 and 100
    and (p_value->>'failureCode') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
    return true;
  end if;

  if not (p_value ? 'remoteRevocation')
    or (p_value - 'remoteRevocation') <> '{}'::jsonb then
    return false;
  end if;
  v_revocation := p_value->'remoteRevocation';
  if pg_catalog.jsonb_typeof(v_revocation) <> 'object'
    or not (v_revocation ?& array['attempted', 'state'])
    or (v_revocation - array['attempted', 'state']) <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(v_revocation->'attempted') <> 'boolean'
    or pg_catalog.jsonb_typeof(v_revocation->'state') <> 'string' then
    return false;
  end if;
  v_attempted := (v_revocation->>'attempted')::boolean;
  v_state := v_revocation->>'state';
  return (not v_attempted and v_state = 'remote_revocation_unavailable')
    or (v_attempted and v_state in ('remote_revocation_confirmed', 'remote_revocation_failed'));
end;
$function$;

do $request_argument_constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.heygen_media_jobs'::pg_catalog.regclass
      and conname = 'heygen_media_jobs_request_arguments_check'
  ) then
    alter table public.heygen_media_jobs
      add constraint heygen_media_jobs_request_arguments_check
      check (social_cues_private.heygen_valid_request_arguments(action, request_arguments))
      not valid;
  end if;
end;
$request_argument_constraint$;

alter table public.heygen_media_jobs
  validate constraint heygen_media_jobs_request_arguments_check;

do $operation_safe_result_constraint$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'social_cues_private.heygen_operation_receipts'::pg_catalog.regclass
      and conname = 'heygen_operation_receipts_safe_result_check'
  ) then
    alter table social_cues_private.heygen_operation_receipts
      add constraint heygen_operation_receipts_safe_result_check
      check (social_cues_private.heygen_valid_operation_safe_result(safe_result))
      not valid;
  end if;
end;
$operation_safe_result_constraint$;

alter table social_cues_private.heygen_operation_receipts
  validate constraint heygen_operation_receipts_safe_result_check;

create or replace function social_cues_private.heygen_account_json(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.to_jsonb(ca)
    || pg_catalog.jsonb_build_object(
      'encrypted_token', pt.encrypted_token,
      'encrypted_refresh_token', pt.encrypted_refresh_token,
      'token_type', pt.token_type,
      'expires_at', pt.expires_at,
      'credential_updated_at', pt.updated_at
    )
  from public.connected_accounts ca
  join public.provider_tokens pt
    on pt.connected_account_id = ca.id
   and pt.workspace_id = ca.workspace_id
   and pt.user_id = ca.user_id
   and pt.provider = 'heygen'
   and pt.token_kind = 'oauth'
  where ca.workspace_id = p_workspace_id
    and ca.user_id = p_actor_user_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen'
    and ca.status = 'connected'
  limit 1;
$function$;

create or replace function social_cues_private.heygen_job_json(p_job_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', j.id,
    'workspace_id', j.workspace_id,
    'requesting_user_id', j.requesting_user_id,
    'connected_account_id', j.connected_account_id,
    'provider', j.provider,
    'action', j.action,
    'operation_id', j.operation_id,
    'status', j.status,
    'provider_job_id', j.provider_job_id,
    'provider_session_id', j.provider_session_id,
    'capability_id', j.capability_id,
    'capability_tool_name', j.capability_tool_name,
    'source_asset_id', j.source_asset_id,
    'parent_asset_id', j.parent_asset_id,
    'root_asset_id', j.root_asset_id,
    'output_asset_id', j.output_asset_id,
    'failure_code', j.failure_code,
    'public_message', j.public_message,
    'created_at', j.created_at,
    'updated_at', j.updated_at,
    'completed_at', j.completed_at
  )
  from public.heygen_media_jobs j
  where j.id = p_job_id;
$function$;

create or replace function social_cues_private.heygen_version_json(p_asset_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', a.id,
    'workspace_id', a.workspace_id,
    'owner_user_id', a.owner_user_id,
    'provider', a.provider,
    'kind', a.kind,
    'title', a.title,
    'status', a.status,
    'content_type', a.content_type,
    'preview_url', a.preview_url,
    'provider_resource_id', a.provider_resource_id,
    'source_asset_id', a.source_asset_id,
    'parent_asset_id', a.parent_asset_id,
    'root_asset_id', a.root_asset_id,
    'version_number', a.version_number,
    'immutable', a.immutable,
    'provider_session_id', a.provider_session_id,
    'provider_job_id', a.provider_job_id,
    'operation_id', a.operation_id,
    'created_at', a.created_at,
    'updated_at', a.updated_at
  )
  from public.media_assets a
  where a.id = p_asset_id and a.provider = 'heygen';
$function$;

create or replace function public.social_cues_enforce_heygen_media_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if tg_op = 'UPDATE' and old.provider = 'heygen' and old.immutable then
    raise exception using errcode = '23514', message = 'HEYGEN_MEDIA_IMMUTABLE';
  end if;
  if tg_op = 'DELETE' and old.provider = 'heygen' and old.immutable
    and exists (
      select 1 from public.workspaces w where w.id = old.workspace_id
  ) then
    raise exception using errcode = '23514', message = 'HEYGEN_MEDIA_IMMUTABLE';
  end if;
  if tg_op = 'INSERT' and new.provider = 'heygen'
    and coalesce(pg_catalog.current_setting('social_cues.heygen_lineage_write', true), '') <> 'on' then
    raise exception using errcode = '42501', message = 'HEYGEN_MEDIA_WRITE_REQUIRES_TRANSACTION';
  end if;
  if tg_op = 'UPDATE' and old.provider <> 'heygen' and new.provider = 'heygen' then
    raise exception using errcode = '42501', message = 'HEYGEN_MEDIA_WRITE_REQUIRES_TRANSACTION';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

drop trigger if exists social_cues_heygen_media_immutability on public.media_assets;
create trigger social_cues_heygen_media_immutability
before insert or update or delete on public.media_assets
for each row execute function public.social_cues_enforce_heygen_media_immutability();

alter table public.connected_accounts enable row level security;
alter table public.connected_accounts force row level security;
alter table public.provider_tokens enable row level security;
alter table public.provider_tokens force row level security;
alter table public.media_assets enable row level security;
alter table public.media_assets force row level security;
alter table public.heygen_media_jobs enable row level security;
alter table public.heygen_media_jobs force row level security;
alter table social_cues_private.heygen_oauth_states enable row level security;
alter table social_cues_private.heygen_oauth_states force row level security;
alter table social_cues_private.heygen_operation_receipts enable row level security;
alter table social_cues_private.heygen_operation_receipts force row level security;

drop policy if exists "heygen accounts remain owner scoped" on public.connected_accounts;
drop policy if exists "members can read connected accounts" on public.connected_accounts;
create policy "members can read connected accounts"
  on public.connected_accounts for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = connected_accounts.workspace_id
        and wm.user_id = (select auth.uid())
        and coalesce(wm.membership_status, 'active') = 'active'
    )
    and public.social_cues_has_active_entitlement(connected_accounts.workspace_id, (select auth.uid()))
  );

create policy "heygen accounts remain owner scoped"
  on public.connected_accounts as restrictive for select to authenticated
  using (provider <> 'heygen' or platform <> 'heygen' or user_id = (select auth.uid()));

drop policy if exists "heygen jobs are requester readable" on public.heygen_media_jobs;
create policy "heygen jobs are requester readable"
  on public.heygen_media_jobs for select to authenticated
  using (
    requesting_user_id = (select auth.uid())
    and exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = heygen_media_jobs.workspace_id
        and wm.user_id = (select auth.uid())
        and coalesce(wm.membership_status, 'active') = 'active'
    )
    and public.social_cues_has_active_entitlement(heygen_media_jobs.workspace_id, (select auth.uid()))
  );

drop policy if exists "heygen media remains owner scoped" on public.media_assets;
create policy "heygen media remains owner scoped"
  on public.media_assets as restrictive for select to authenticated
  using (provider <> 'heygen' or owner_user_id = (select auth.uid()));

drop policy if exists "authenticated clients cannot create heygen media" on public.media_assets;
create policy "authenticated clients cannot create heygen media"
  on public.media_assets as restrictive for insert to authenticated
  with check (provider <> 'heygen');

drop policy if exists "authenticated clients cannot update heygen media" on public.media_assets;
create policy "authenticated clients cannot update heygen media"
  on public.media_assets as restrictive for update to authenticated
  using (provider <> 'heygen')
  with check (provider <> 'heygen');

revoke all on schema social_cues_private from public, anon, authenticated;
grant usage on schema social_cues_private to service_role;
revoke all on all tables in schema social_cues_private from public, anon, authenticated;
grant select, insert, update, delete on table
  social_cues_private.heygen_oauth_states,
  social_cues_private.heygen_operation_receipts
to service_role;

revoke all on table public.provider_tokens from public, anon, authenticated;
revoke all on table public.heygen_media_jobs from public, anon, authenticated;
grant select (
  id, workspace_id, requesting_user_id, connected_account_id, provider, action,
  operation_id, status, provider_job_id, provider_session_id, capability_id,
  capability_tool_name, source_asset_id, parent_asset_id, root_asset_id,
  output_asset_id, failure_code, public_message, created_at, updated_at, completed_at
) on public.heygen_media_jobs to authenticated;
grant select, insert, update, delete on public.heygen_media_jobs to service_role;
grant select, insert, update, delete on public.connected_accounts, public.provider_tokens, public.media_assets to service_role;
grant select on public.workspaces, public.workspace_members, public.billing_entitlements to service_role;
grant select on public.connected_accounts to authenticated;

create or replace function public.social_cues_heygen_repository_health()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform social_cues_private.heygen_assert_service_role();
  return pg_catalog.jsonb_build_object(
    'contract_version', 'social-cues.heygen-durable.v1',
    'interface_fingerprint', 'heygen-durable-v1-oauth-account-job-lineage'
  );
end;
$function$;

create or replace function public.social_cues_heygen_oauth_state_issue(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_state_digest text,
  p_protected_verifier jsonb,
  p_metadata jsonb,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state social_cues_private.heygen_oauth_states%rowtype;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if p_state_digest !~ '^[A-Za-z0-9_-]{43}$'
    or not social_cues_private.heygen_valid_envelope(p_protected_verifier)
    or not social_cues_private.heygen_valid_metadata(p_metadata)
    or p_issued_at is null
    or p_expires_at is null
    or p_expires_at <= p_issued_at
    or p_expires_at > p_issued_at + interval '15 minutes'
    or p_expires_at <= pg_catalog.now() then
    raise exception using errcode = '22023', message = 'HEYGEN_STATE_INVALID';
  end if;

  delete from social_cues_private.heygen_oauth_states s
  where s.expires_at < pg_catalog.now() - interval '1 day'
     or coalesce(s.completed_at, s.cancelled_at) < pg_catalog.now() - interval '7 days';

  insert into social_cues_private.heygen_oauth_states (
    state_digest, workspace_id, actor_user_id, protected_verifier,
    discovered_metadata, issued_at, expires_at
  ) values (
    p_state_digest, p_workspace_id, p_actor_user_id, p_protected_verifier,
    p_metadata, p_issued_at, p_expires_at
  )
  on conflict (state_digest) do nothing;

  select * into v_state
  from social_cues_private.heygen_oauth_states s
  where s.state_digest = p_state_digest
  for update;

  if v_state.state_digest is null
    or v_state.workspace_id <> p_workspace_id
    or v_state.actor_user_id <> p_actor_user_id
    or v_state.protected_verifier <> p_protected_verifier
    or v_state.discovered_metadata <> p_metadata
    or v_state.issued_at <> p_issued_at
    or v_state.expires_at <> p_expires_at
    or v_state.consumed_at is not null
    or v_state.cancelled_at is not null then
    raise exception using errcode = '23505', message = 'HEYGEN_STATE_CONFLICT';
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'issued');
end;
$function$;

create or replace function public.social_cues_heygen_oauth_state_consume(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_state_digest text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state social_cues_private.heygen_oauth_states%rowtype;
  v_verifier jsonb;
  v_metadata jsonb;
  v_account jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if p_state_digest !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'HEYGEN_STATE_INVALID';
  end if;

  select * into v_state
  from social_cues_private.heygen_oauth_states s
  where s.state_digest = p_state_digest
  for update;

  if v_state.state_digest is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_STATE_REPLAYED';
  end if;
  if v_state.workspace_id <> p_workspace_id or v_state.actor_user_id <> p_actor_user_id then
    raise exception using errcode = '42501', message = 'HEYGEN_STATE_OWNER_MISMATCH';
  end if;
  if v_state.completed_at is not null then
    v_account := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
    if v_account is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'completed', 'account', v_account);
  end if;
  if v_state.cancelled_at is not null or v_state.consumed_at is not null then
    raise exception using errcode = '23505', message = 'HEYGEN_STATE_NOT_CONSUMABLE';
  end if;
  if v_state.expires_at <= pg_catalog.now() then
    update social_cues_private.heygen_oauth_states
    set protected_verifier = null,
        discovered_metadata = null,
        cancelled_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where state_digest = p_state_digest;
    return pg_catalog.jsonb_build_object('outcome', 'expired');
  end if;

  v_verifier := v_state.protected_verifier;
  v_metadata := v_state.discovered_metadata;
  update social_cues_private.heygen_oauth_states
  set protected_verifier = null,
      discovered_metadata = null,
      consumed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where state_digest = p_state_digest;

  return pg_catalog.jsonb_build_object(
    'outcome', 'consumed',
    'state_digest', p_state_digest,
    'protected_verifier', v_verifier,
    'metadata', v_metadata
  );
end;
$function$;

create or replace function public.social_cues_heygen_oauth_state_cancel(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_state_digest text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state social_cues_private.heygen_oauth_states%rowtype;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  select * into v_state
  from social_cues_private.heygen_oauth_states s
  where s.state_digest = p_state_digest
  for update;
  if v_state.state_digest is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_STATE_REPLAYED';
  end if;
  if v_state.workspace_id <> p_workspace_id or v_state.actor_user_id <> p_actor_user_id then
    raise exception using errcode = '42501', message = 'HEYGEN_STATE_OWNER_MISMATCH';
  end if;
  if v_state.completed_at is not null or v_state.consumed_at is not null then
    raise exception using errcode = '23505', message = 'HEYGEN_STATE_NOT_CONSUMABLE';
  end if;
  update social_cues_private.heygen_oauth_states
  set protected_verifier = null,
      discovered_metadata = null,
      cancelled_at = coalesce(cancelled_at, pg_catalog.now()),
      updated_at = pg_catalog.now()
  where state_digest = p_state_digest;
  return pg_catalog.jsonb_build_object('outcome', 'cancelled');
end;
$function$;

create or replace function public.social_cues_heygen_connection_commit(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_state_digest text,
  p_connected_account_id uuid,
  p_provider_account_id text,
  p_display_name text,
  p_scopes text[],
  p_public_profile jsonb,
  p_encrypted_access_token jsonb,
  p_encrypted_refresh_token jsonb,
  p_token_type text,
  p_expires_at timestamptz,
  p_connected_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state social_cues_private.heygen_oauth_states%rowtype;
  v_account public.connected_accounts%rowtype;
  v_result jsonb;
  v_replayed boolean := false;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if p_state_digest !~ '^[A-Za-z0-9_-]{43}$'
    or p_connected_account_id is null
    or nullif(pg_catalog.btrim(p_provider_account_id), '') is null
    or pg_catalog.length(p_provider_account_id) > 500
    or nullif(pg_catalog.btrim(p_display_name), '') is null
    or pg_catalog.length(p_display_name) > 300
    or p_token_type <> 'Bearer'
    or not social_cues_private.heygen_valid_public_profile(p_public_profile)
    or not social_cues_private.heygen_valid_envelope(p_encrypted_access_token)
    or (p_encrypted_refresh_token is not null and not social_cues_private.heygen_valid_envelope(p_encrypted_refresh_token)) then
    raise exception using errcode = '22023', message = 'HEYGEN_CONNECTION_INPUT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text || ':heygen-account', 0));
  select * into v_state
  from social_cues_private.heygen_oauth_states s
  where s.state_digest = p_state_digest
  for update;

  if v_state.state_digest is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_STATE_REPLAYED';
  end if;
  if v_state.workspace_id <> p_workspace_id or v_state.actor_user_id <> p_actor_user_id then
    raise exception using errcode = '42501', message = 'HEYGEN_STATE_OWNER_MISMATCH';
  end if;
  if v_state.completed_at is not null then
    v_result := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
    if v_result is null then raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED'; end if;
    return pg_catalog.jsonb_build_object('replayed', true, 'account', v_result);
  end if;
  if v_state.consumed_at is null or v_state.cancelled_at is not null then
    raise exception using errcode = '23505', message = 'HEYGEN_STATE_NOT_CONSUMABLE';
  end if;

  select * into v_account
  from public.connected_accounts ca
  where ca.workspace_id = p_workspace_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen'
  for update;

  if v_account.id is not null and v_account.user_id <> p_actor_user_id then
    raise exception using errcode = '42501', message = 'HEYGEN_NOT_AUTHORIZED';
  end if;

  if v_account.id is null then
    insert into public.connected_accounts (
      id, workspace_id, user_id, provider, platform, provider_account_id,
      display_name, handle, status, scopes, public_profile, connected_at,
      last_sync_at, created_at, updated_at
    ) values (
      p_connected_account_id, p_workspace_id, p_actor_user_id, 'heygen', 'heygen',
      pg_catalog.btrim(p_provider_account_id), pg_catalog.btrim(p_display_name),
      pg_catalog.btrim(p_display_name), 'connected', coalesce(p_scopes, '{}'::text[]),
      p_public_profile, coalesce(p_connected_at, pg_catalog.now()), pg_catalog.now(),
      pg_catalog.now(), pg_catalog.now()
    ) returning * into v_account;
  else
    update public.connected_accounts
    set provider_account_id = pg_catalog.btrim(p_provider_account_id),
        display_name = pg_catalog.btrim(p_display_name),
        handle = pg_catalog.btrim(p_display_name),
        status = 'connected',
        scopes = coalesce(p_scopes, '{}'::text[]),
        public_profile = p_public_profile,
        connected_at = coalesce(v_account.connected_at, p_connected_at, pg_catalog.now()),
        last_sync_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = v_account.id
    returning * into v_account;
  end if;

  insert into public.provider_tokens (
    connected_account_id, workspace_id, user_id, provider, token_kind,
    encrypted_token, encrypted_refresh_token, token_type, scopes, expires_at,
    refresh_expires_at, created_at, updated_at
  ) values (
    v_account.id, p_workspace_id, p_actor_user_id, 'heygen', 'oauth',
    p_encrypted_access_token, p_encrypted_refresh_token, 'Bearer',
    coalesce(p_scopes, '{}'::text[]), p_expires_at, null,
    pg_catalog.now(), pg_catalog.now()
  )
  on conflict (connected_account_id, token_kind) do update
  set workspace_id = excluded.workspace_id,
      user_id = excluded.user_id,
      provider = excluded.provider,
      encrypted_token = excluded.encrypted_token,
      encrypted_refresh_token = excluded.encrypted_refresh_token,
      token_type = excluded.token_type,
      scopes = excluded.scopes,
      expires_at = excluded.expires_at,
      updated_at = pg_catalog.now();

  update social_cues_private.heygen_oauth_states
  set completed_at = pg_catalog.now(),
      connected_account_id = v_account.id,
      protected_verifier = null,
      discovered_metadata = null,
      updated_at = pg_catalog.now()
  where state_digest = p_state_digest;

  v_result := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
  return pg_catalog.jsonb_build_object('replayed', v_replayed, 'account', v_result);
end;
$function$;

create or replace function public.social_cues_heygen_account_context(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  return pg_catalog.jsonb_build_object(
    'account', social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id)
  );
end;
$function$;

create or replace function public.social_cues_heygen_account_operation_begin(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_operation_id text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_receipt social_cues_private.heygen_operation_receipts%rowtype;
  v_account jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if v_action not in ('refresh', 'disconnect')
    or pg_catalog.length(p_operation_id) > 500
    or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_fingerprint !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception using errcode = '22023', message = 'HEYGEN_OPERATION_INPUT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:' || v_action || ':' || p_operation_id, 0)
  );
  select * into v_receipt
  from social_cues_private.heygen_operation_receipts r
  where r.workspace_id = p_workspace_id
    and r.provider = 'heygen'
    and r.operation_kind = v_action
    and r.operation_id = p_operation_id
  for update;

  if v_receipt.operation_id is not null then
    if v_receipt.actor_user_id <> p_actor_user_id
      or v_receipt.request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
    end if;
    if v_receipt.status = 'completed' then
      return pg_catalog.jsonb_build_object(
        'outcome', 'completed',
        'safe_result', v_receipt.safe_result,
        'account', social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id)
      );
    elsif v_receipt.status = 'failed' then
      return pg_catalog.jsonb_build_object('outcome', 'failed', 'safe_result', v_receipt.safe_result);
    else
      return pg_catalog.jsonb_build_object('outcome', 'in_progress', 'safe_result', '{}'::jsonb);
    end if;
  end if;

  v_account := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
  if v_action = 'refresh' and v_account is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
  end if;
  insert into social_cues_private.heygen_operation_receipts (
    workspace_id, actor_user_id, provider, operation_kind, operation_id,
    request_fingerprint, status, safe_result
  ) values (
    p_workspace_id, p_actor_user_id, 'heygen', v_action, p_operation_id,
    p_request_fingerprint, 'pending', '{}'::jsonb
  );
  return pg_catalog.jsonb_build_object(
    'outcome', 'acquired',
    'safe_result', '{}'::jsonb,
    'account', v_account
  );
end;
$function$;

create or replace function public.social_cues_heygen_refresh_complete(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_operation_id text,
  p_request_fingerprint text,
  p_provider_account_id text,
  p_display_name text,
  p_scopes text[],
  p_public_profile jsonb,
  p_encrypted_access_token jsonb,
  p_encrypted_refresh_token jsonb,
  p_token_type text,
  p_expires_at timestamptz,
  p_credential_updated_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_receipt social_cues_private.heygen_operation_receipts%rowtype;
  v_account public.connected_accounts%rowtype;
  v_result jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if pg_catalog.length(p_operation_id) > 500
    or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or p_token_type <> 'Bearer'
    or nullif(pg_catalog.btrim(p_provider_account_id), '') is null
    or pg_catalog.length(p_provider_account_id) > 500
    or nullif(pg_catalog.btrim(p_display_name), '') is null
    or pg_catalog.length(p_display_name) > 300
    or not social_cues_private.heygen_valid_public_profile(p_public_profile)
    or not social_cues_private.heygen_valid_envelope(p_encrypted_access_token)
    or (p_encrypted_refresh_token is not null and not social_cues_private.heygen_valid_envelope(p_encrypted_refresh_token)) then
    raise exception using errcode = '22023', message = 'HEYGEN_REFRESH_INPUT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:refresh:' || p_operation_id, 0)
  );
  select * into v_receipt
  from social_cues_private.heygen_operation_receipts r
  where r.workspace_id = p_workspace_id
    and r.provider = 'heygen'
    and r.operation_kind = 'refresh'
    and r.operation_id = p_operation_id
  for update;
  if v_receipt.operation_id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_OPERATION_IN_PROGRESS';
  end if;
  if v_receipt.actor_user_id <> p_actor_user_id
    or v_receipt.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;
  if v_receipt.status = 'completed' then
    v_result := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
    return pg_catalog.jsonb_build_object('replayed', true, 'account', v_result);
  end if;
  if v_receipt.status <> 'pending' then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;

  select * into v_account
  from public.connected_accounts ca
  where ca.workspace_id = p_workspace_id
    and ca.user_id = p_actor_user_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen'
    and ca.status = 'connected'
  for update;
  if v_account.id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
  end if;
  if v_account.provider_account_id <> p_provider_account_id then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;

  update public.connected_accounts
  set display_name = pg_catalog.btrim(p_display_name),
      handle = pg_catalog.btrim(p_display_name),
      scopes = coalesce(p_scopes, '{}'::text[]),
      public_profile = p_public_profile,
      last_sync_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_account.id;

  update public.provider_tokens
  set encrypted_token = p_encrypted_access_token,
      encrypted_refresh_token = coalesce(p_encrypted_refresh_token, encrypted_refresh_token),
      token_type = 'Bearer',
      scopes = coalesce(p_scopes, '{}'::text[]),
      expires_at = p_expires_at,
      updated_at = coalesce(p_credential_updated_at, pg_catalog.now())
  where connected_account_id = v_account.id
    and workspace_id = p_workspace_id
    and user_id = p_actor_user_id
    and provider = 'heygen'
    and token_kind = 'oauth';
  if not found then
    raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
  end if;

  update social_cues_private.heygen_operation_receipts
  set status = 'completed',
      safe_result = pg_catalog.jsonb_build_object('refreshed', true),
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where workspace_id = p_workspace_id
    and provider = 'heygen'
    and operation_kind = 'refresh'
    and operation_id = p_operation_id;

  v_result := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
  return pg_catalog.jsonb_build_object('replayed', false, 'account', v_result);
end;
$function$;

create or replace function public.social_cues_heygen_disconnect_complete(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_operation_id text,
  p_request_fingerprint text,
  p_safe_result jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_receipt social_cues_private.heygen_operation_receipts%rowtype;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if pg_catalog.length(p_operation_id) > 500
    or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or not social_cues_private.heygen_valid_operation_safe_result(p_safe_result)
    or not (p_safe_result ? 'remoteRevocation')
    or (p_safe_result - 'remoteRevocation') <> '{}'::jsonb then
    raise exception using errcode = '22023', message = 'HEYGEN_DISCONNECT_INPUT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:disconnect:' || p_operation_id, 0)
  );
  select * into v_receipt
  from social_cues_private.heygen_operation_receipts r
  where r.workspace_id = p_workspace_id
    and r.provider = 'heygen'
    and r.operation_kind = 'disconnect'
    and r.operation_id = p_operation_id
  for update;
  if v_receipt.operation_id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_OPERATION_IN_PROGRESS';
  end if;
  if v_receipt.actor_user_id <> p_actor_user_id
    or v_receipt.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;
  if v_receipt.status = 'completed' then
    return pg_catalog.jsonb_build_object('replayed', true, 'safe_result', v_receipt.safe_result);
  end if;
  if v_receipt.status <> 'pending' then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;

  delete from public.provider_tokens pt
  using public.connected_accounts ca
  where ca.id = pt.connected_account_id
    and ca.workspace_id = p_workspace_id
    and ca.user_id = p_actor_user_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen'
    and pt.provider = 'heygen';
  delete from public.connected_accounts ca
  where ca.workspace_id = p_workspace_id
    and ca.user_id = p_actor_user_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen';

  update social_cues_private.heygen_operation_receipts
  set status = 'completed',
      safe_result = p_safe_result,
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where workspace_id = p_workspace_id
    and provider = 'heygen'
    and operation_kind = 'disconnect'
    and operation_id = p_operation_id;
  return pg_catalog.jsonb_build_object('replayed', false, 'safe_result', p_safe_result);
end;
$function$;

create or replace function public.social_cues_heygen_account_operation_fail(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_operation_id text,
  p_request_fingerprint text,
  p_failure_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_receipt social_cues_private.heygen_operation_receipts%rowtype;
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if v_action not in ('refresh', 'disconnect')
    or pg_catalog.length(p_operation_id) > 500
    or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or pg_catalog.length(p_failure_code) > 100
    or p_failure_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
    raise exception using errcode = '22023', message = 'HEYGEN_OPERATION_INPUT_INVALID';
  end if;
  select * into v_receipt
  from social_cues_private.heygen_operation_receipts r
  where r.workspace_id = p_workspace_id
    and r.provider = 'heygen'
    and r.operation_kind = v_action
    and r.operation_id = p_operation_id
  for update;
  if v_receipt.operation_id is null
    or v_receipt.actor_user_id <> p_actor_user_id
    or v_receipt.request_fingerprint <> p_request_fingerprint then
    raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
  end if;
  if v_receipt.status = 'pending' then
    update social_cues_private.heygen_operation_receipts
    set status = 'failed',
        failure_code = p_failure_code,
        safe_result = pg_catalog.jsonb_build_object('failureCode', p_failure_code),
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where workspace_id = p_workspace_id
      and provider = 'heygen'
      and operation_kind = v_action
      and operation_id = p_operation_id;
  end if;
  return pg_catalog.jsonb_build_object('outcome', 'failed');
end;
$function$;

create or replace function public.social_cues_heygen_job_reserve(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_operation_id text,
  p_request_fingerprint text,
  p_request_arguments jsonb,
  p_source_asset_id uuid,
  p_parent_asset_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_account public.connected_accounts%rowtype;
  v_existing public.heygen_media_jobs%rowtype;
  v_source public.media_assets%rowtype;
  v_parent public.media_assets%rowtype;
  v_job_id uuid;
  v_remaining numeric;
  v_available boolean;
  v_account_json jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if v_action not in (
      'prompt_to_video', 'revise_video', 'create_variant', 'avatar_video',
      'template_video', 'replace_audio', 'translate_video', 'remove_fillers'
    )
    or pg_catalog.length(p_operation_id) > 500
    or p_operation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    or p_request_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or not social_cues_private.heygen_valid_request_arguments(v_action, p_request_arguments)
    or (
      p_request_arguments ? 'sourceAssetId'
      and (
        pg_catalog.jsonb_typeof(p_request_arguments->'sourceAssetId') <> 'string'
        or (p_request_arguments->>'sourceAssetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or p_source_asset_id is null
        or pg_catalog.lower(p_request_arguments->>'sourceAssetId') <> p_source_asset_id::text
      )
    )
    or (
      not (p_request_arguments ? 'sourceAssetId')
      and p_source_asset_id is not null
    )
    or (
      p_request_arguments ? 'parentVersionId'
      and (
        pg_catalog.jsonb_typeof(p_request_arguments->'parentVersionId') <> 'string'
        or (p_request_arguments->>'parentVersionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or p_parent_asset_id is null
        or pg_catalog.lower(p_request_arguments->>'parentVersionId') <> p_parent_asset_id::text
      )
    )
    or (
      not (p_request_arguments ? 'parentVersionId')
      and p_parent_asset_id is not null
    ) then
    raise exception using errcode = '22023', message = 'HEYGEN_JOB_INPUT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:job:' || p_operation_id, 0)
  );
  select * into v_existing
  from public.heygen_media_jobs j
  where j.workspace_id = p_workspace_id
    and j.provider = 'heygen'
    and j.operation_id = p_operation_id
  for update;
  if v_existing.id is not null then
    if v_existing.requesting_user_id <> p_actor_user_id
      or v_existing.action <> v_action
      or v_existing.request_fingerprint <> p_request_fingerprint
      or v_existing.request_arguments <> p_request_arguments
      or v_existing.source_asset_id is distinct from p_source_asset_id
      or v_existing.parent_asset_id is distinct from p_parent_asset_id then
      raise exception using errcode = '23505', message = 'HEYGEN_OPERATION_CONFLICT';
    end if;
    return pg_catalog.jsonb_build_object(
      'replayed', true,
      'job', social_cues_private.heygen_job_json(v_existing.id),
      'request_arguments', v_existing.request_arguments,
      'account', case
        when v_existing.status in ('completed', 'failed') then null
        else social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id)
      end
    );
  end if;

  select * into v_account
  from public.connected_accounts ca
  where ca.workspace_id = p_workspace_id
    and ca.user_id = p_actor_user_id
    and ca.provider = 'heygen'
    and ca.platform = 'heygen'
    and ca.status = 'connected'
  for update;
  if v_account.id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
  end if;

  if pg_catalog.jsonb_typeof(v_account.public_profile->'credits'->'remaining') = 'number' then
    v_remaining := (v_account.public_profile->'credits'->>'remaining')::numeric;
  end if;
  if pg_catalog.jsonb_typeof(v_account.public_profile->'credits'->'available') = 'boolean' then
    v_available := (v_account.public_profile->'credits'->>'available')::boolean;
  end if;
  if v_available is false or (v_remaining is not null and v_remaining <= 0) then
    raise exception using errcode = '22023', message = 'HEYGEN_CREDITS_DEPLETED';
  end if;
  if v_available is not true and (v_remaining is null or v_remaining <= 0) then
    raise exception using errcode = '22023', message = 'HEYGEN_CREDITS_UNVERIFIED';
  end if;

  if p_source_asset_id is not null then
    select * into v_source
    from public.media_assets a
    where a.id = p_source_asset_id
      and a.workspace_id = p_workspace_id
      and a.owner_user_id = p_actor_user_id
    for share;
    if v_source.id is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_SOURCE_NOT_FOUND';
    end if;
  end if;

  if p_parent_asset_id is not null then
    select * into v_parent
    from public.media_assets a
    where a.id = p_parent_asset_id
      and a.workspace_id = p_workspace_id
      and a.owner_user_id = p_actor_user_id
      and a.provider = 'heygen'
      and a.immutable
    for share;
    if v_parent.id is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_PARENT_NOT_FOUND';
    end if;
  end if;

  if v_action in ('revise_video', 'create_variant', 'replace_audio', 'translate_video', 'remove_fillers')
    and p_source_asset_id is null
    and p_parent_asset_id is null then
    raise exception using errcode = '22023', message = 'HEYGEN_LINEAGE_REQUIRED';
  end if;

  v_job_id := pg_catalog.gen_random_uuid();
  insert into public.heygen_media_jobs (
    id, workspace_id, requesting_user_id, connected_account_id, provider,
    action, operation_id, request_fingerprint, request_arguments, status,
    source_asset_id, parent_asset_id, root_asset_id
  ) values (
    v_job_id, p_workspace_id, p_actor_user_id, v_account.id, 'heygen',
    v_action, p_operation_id, p_request_fingerprint, p_request_arguments, 'submitted',
    p_source_asset_id, p_parent_asset_id,
    case
      when v_parent.id is not null then coalesce(v_parent.root_asset_id, v_parent.id)
      when v_source.id is not null then v_source.id
      else null
    end
  );

  v_account_json := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
  if v_account_json is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
  end if;
  return pg_catalog.jsonb_build_object(
    'replayed', false,
    'job', social_cues_private.heygen_job_json(v_job_id),
    'request_arguments', p_request_arguments,
    'account', v_account_json
  );
end;
$function$;

create or replace function public.social_cues_heygen_job_context(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_job public.heygen_media_jobs%rowtype;
  v_account jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  select * into v_job
  from public.heygen_media_jobs j
  where j.id = p_job_id
    and j.workspace_id = p_workspace_id
    and j.requesting_user_id = p_actor_user_id
    and j.provider = 'heygen';
  if v_job.id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_JOB_NOT_FOUND';
  end if;

  if v_job.status not in ('completed', 'failed') then
    v_account := social_cues_private.heygen_account_json(p_actor_user_id, p_workspace_id);
    if v_account is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_ACCOUNT_REQUIRED';
    end if;
  end if;
  return pg_catalog.jsonb_build_object(
    'job', social_cues_private.heygen_job_json(v_job.id),
    'request_arguments', case when v_job.status in ('completed', 'failed') then '{}'::jsonb else v_job.request_arguments end,
    'account', v_account
  );
end;
$function$;

create or replace function public.social_cues_heygen_job_transition(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_job_id uuid,
  p_state text,
  p_result_fingerprint text,
  p_provider_job_id text,
  p_provider_session_id text,
  p_capability_id text,
  p_capability_tool_name text,
  p_provider_resource_id text,
  p_preview_url text,
  p_title text,
  p_failure_code text,
  p_public_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_state text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_state, '')));
  v_job public.heygen_media_jobs%rowtype;
  v_source public.media_assets%rowtype;
  v_parent public.media_assets%rowtype;
  v_asset_id uuid;
  v_root_asset_id uuid;
  v_version_number integer;
  v_title text;
  v_version jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  if v_state not in ('processing', 'completed', 'failed')
    or p_result_fingerprint !~ '^[A-Za-z0-9_-]{43}$'
    or (p_provider_job_id is not null and (
      pg_catalog.length(p_provider_job_id) > 500
      or p_provider_job_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_provider_session_id is not null and (
      pg_catalog.length(p_provider_session_id) > 500
      or p_provider_session_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_capability_id is not null and (
      pg_catalog.length(p_capability_id) > 120
      or p_capability_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_capability_tool_name is not null and (
      pg_catalog.length(p_capability_tool_name) > 200
      or p_capability_tool_name !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_provider_resource_id is not null and (
      pg_catalog.length(p_provider_resource_id) > 500
      or p_provider_resource_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_preview_url is not null and (
      pg_catalog.length(p_preview_url) > 2000
      or p_preview_url !~ '^https://[^[:space:]]+$'
    ))
    or (p_title is not null and (
      nullif(pg_catalog.btrim(p_title), '') is null
      or pg_catalog.length(p_title) > 200
    ))
    or (p_failure_code is not null and (
      pg_catalog.length(p_failure_code) > 100
      or p_failure_code !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
    ))
    or (p_public_message is not null and pg_catalog.length(p_public_message) > 500) then
    raise exception using errcode = '22023', message = 'HEYGEN_RESULT_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:job-id:' || p_job_id::text, 0)
  );
  select * into v_job
  from public.heygen_media_jobs j
  where j.id = p_job_id
    and j.workspace_id = p_workspace_id
    and j.requesting_user_id = p_actor_user_id
    and j.provider = 'heygen'
  for update;
  if v_job.id is null then
    raise exception using errcode = 'P0002', message = 'HEYGEN_JOB_NOT_FOUND';
  end if;

  if v_job.status in ('completed', 'failed') then
    if v_job.status = v_state and v_job.result_fingerprint = p_result_fingerprint then
      if v_job.output_asset_id is not null then
        v_version := social_cues_private.heygen_version_json(v_job.output_asset_id);
      end if;
      return pg_catalog.jsonb_build_object(
        'replayed', true,
        'job', social_cues_private.heygen_job_json(v_job.id),
        'version', v_version
      );
    end if;
    raise exception using errcode = '23505', message = 'HEYGEN_RESULT_TERMINAL_CONFLICT';
  end if;

  if v_job.provider_job_id is not null
    and p_provider_job_id is not null
    and v_job.provider_job_id <> p_provider_job_id then
    raise exception using errcode = '23505', message = 'HEYGEN_RESULT_TERMINAL_CONFLICT';
  end if;
  if v_job.provider_session_id is not null
    and p_provider_session_id is not null
    and v_job.provider_session_id <> p_provider_session_id then
    raise exception using errcode = '23505', message = 'HEYGEN_RESULT_TERMINAL_CONFLICT';
  end if;

  if v_state = 'processing' then
    if coalesce(p_provider_job_id, v_job.provider_job_id) is null
      and coalesce(p_provider_session_id, v_job.provider_session_id) is null then
      raise exception using errcode = '22023', message = 'HEYGEN_RESULT_INVALID';
    end if;
    if v_job.status = 'processing'
      and v_job.result_fingerprint = p_result_fingerprint then
      return pg_catalog.jsonb_build_object(
        'replayed', true,
        'job', social_cues_private.heygen_job_json(v_job.id),
        'version', null
      );
    end if;
    update public.heygen_media_jobs
    set status = 'processing',
        result_fingerprint = p_result_fingerprint,
        provider_job_id = coalesce(p_provider_job_id, provider_job_id),
        provider_session_id = coalesce(p_provider_session_id, provider_session_id),
        capability_id = coalesce(p_capability_id, capability_id),
        capability_tool_name = coalesce(p_capability_tool_name, capability_tool_name),
        public_message = coalesce(p_public_message, public_message),
        updated_at = pg_catalog.now()
    where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'replayed', false,
      'job', social_cues_private.heygen_job_json(v_job.id),
      'version', null
    );
  end if;

  if v_state = 'failed' then
    if p_failure_code is null then
      raise exception using errcode = '22023', message = 'HEYGEN_RESULT_INVALID';
    end if;
    update public.heygen_media_jobs
    set status = 'failed',
        result_fingerprint = p_result_fingerprint,
        provider_job_id = coalesce(p_provider_job_id, provider_job_id),
        provider_session_id = coalesce(p_provider_session_id, provider_session_id),
        capability_id = coalesce(p_capability_id, capability_id),
        capability_tool_name = coalesce(p_capability_tool_name, capability_tool_name),
        failure_code = p_failure_code,
        public_message = coalesce(p_public_message, 'HeyGen could not complete this operation.'),
        completed_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    where id = v_job.id;
    return pg_catalog.jsonb_build_object(
      'replayed', false,
      'job', social_cues_private.heygen_job_json(v_job.id),
      'version', null
    );
  end if;

  if p_provider_resource_id is null and p_preview_url is null then
    raise exception using errcode = '22023', message = 'HEYGEN_RESULT_INVALID';
  end if;
  if v_job.source_asset_id is not null then
    select * into v_source
    from public.media_assets a
    where a.id = v_job.source_asset_id
      and a.workspace_id = p_workspace_id
      and a.owner_user_id = p_actor_user_id
    for share;
    if v_source.id is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_SOURCE_NOT_FOUND';
    end if;
  end if;
  if v_job.parent_asset_id is not null then
    select * into v_parent
    from public.media_assets a
    where a.id = v_job.parent_asset_id
      and a.workspace_id = p_workspace_id
      and a.owner_user_id = p_actor_user_id
      and a.provider = 'heygen'
      and a.immutable
    for share;
    if v_parent.id is null then
      raise exception using errcode = 'P0002', message = 'HEYGEN_PARENT_NOT_FOUND';
    end if;
  end if;

  v_asset_id := pg_catalog.gen_random_uuid();
  v_root_asset_id := coalesce(
    v_job.root_asset_id,
    v_parent.root_asset_id,
    v_parent.id,
    v_source.id,
    v_asset_id
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':heygen:lineage:' || v_root_asset_id::text, 0)
  );
  select coalesce(pg_catalog.max(a.version_number), 0) + 1
  into v_version_number
  from public.media_assets a
  where a.workspace_id = p_workspace_id
    and a.owner_user_id = p_actor_user_id
    and a.provider = 'heygen'
    and a.root_asset_id = v_root_asset_id;

  v_title := coalesce(
    nullif(pg_catalog.btrim(p_title), ''),
    nullif(pg_catalog.btrim(v_job.request_arguments->>'title'), ''),
    case v_job.action
      when 'prompt_to_video' then 'Prompt to video result'
      when 'revise_video' then 'Revise video result'
      when 'create_variant' then 'Create variant result'
      when 'avatar_video' then 'Avatar video result'
      when 'template_video' then 'Template video result'
      when 'replace_audio' then 'Replace audio result'
      when 'translate_video' then 'Translate video result'
      when 'remove_fillers' then 'Remove fillers result'
      else 'HeyGen video result'
    end
  );
  if pg_catalog.length(v_title) > 200 then
    v_title := pg_catalog.left(v_title, 200);
  end if;

  perform pg_catalog.set_config('social_cues.heygen_lineage_write', 'on', true);
  insert into public.media_assets (
    id, workspace_id, owner_user_id, provider, kind, title, status,
    content_type, preview_url, provider_resource_id, source_asset_id,
    parent_asset_id, root_asset_id, version_number, immutable,
    provider_session_id, provider_job_id, operation_id, created_at, updated_at
  ) values (
    v_asset_id, p_workspace_id, p_actor_user_id, 'heygen', 'video', v_title, 'generated',
    'video/mp4', p_preview_url, p_provider_resource_id,
    coalesce(v_job.source_asset_id, v_parent.source_asset_id), v_parent.id,
    v_root_asset_id, v_version_number, true,
    coalesce(p_provider_session_id, v_job.provider_session_id),
    coalesce(p_provider_job_id, v_job.provider_job_id), v_job.operation_id,
    pg_catalog.now(), pg_catalog.now()
  );

  update public.heygen_media_jobs
  set status = 'completed',
      result_fingerprint = p_result_fingerprint,
      provider_job_id = coalesce(p_provider_job_id, provider_job_id),
      provider_session_id = coalesce(p_provider_session_id, provider_session_id),
      capability_id = coalesce(p_capability_id, capability_id),
      capability_tool_name = coalesce(p_capability_tool_name, capability_tool_name),
      root_asset_id = v_root_asset_id,
      output_asset_id = v_asset_id,
      failure_code = null,
      public_message = coalesce(p_public_message, public_message),
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_job.id;

  v_version := social_cues_private.heygen_version_json(v_asset_id);
  return pg_catalog.jsonb_build_object(
    'replayed', false,
    'job', social_cues_private.heygen_job_json(v_job.id),
    'version', v_version
  );
end;
$function$;

create or replace function public.social_cues_heygen_jobs_list(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_jobs jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  select coalesce(pg_catalog.jsonb_agg(
    social_cues_private.heygen_job_json(j.id)
    order by j.created_at desc, j.id desc
  ), '[]'::jsonb)
  into v_jobs
  from public.heygen_media_jobs j
  where j.workspace_id = p_workspace_id
    and j.requesting_user_id = p_actor_user_id
    and j.provider = 'heygen';
  return pg_catalog.jsonb_build_object('jobs', v_jobs);
end;
$function$;

create or replace function public.social_cues_heygen_versions_list(
  p_actor_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_versions jsonb;
begin
  perform social_cues_private.heygen_assert_access(p_actor_user_id, p_workspace_id);
  select coalesce(pg_catalog.jsonb_agg(
    social_cues_private.heygen_version_json(a.id)
    order by a.created_at desc, a.id desc
  ), '[]'::jsonb)
  into v_versions
  from public.media_assets a
  where a.workspace_id = p_workspace_id
    and a.owner_user_id = p_actor_user_id
    and a.provider = 'heygen'
    and a.immutable;
  return pg_catalog.jsonb_build_object('versions', v_versions);
end;
$function$;

revoke all on function public.social_cues_enforce_heygen_media_immutability() from public, anon, authenticated;
revoke all on all functions in schema social_cues_private from public, anon, authenticated;
grant execute on function public.social_cues_enforce_heygen_media_immutability() to service_role;
grant execute on function social_cues_private.heygen_assert_service_role() to service_role;
grant execute on function social_cues_private.heygen_assert_access(uuid, uuid) to service_role;
grant execute on function social_cues_private.heygen_valid_envelope(jsonb) to service_role;
grant execute on function social_cues_private.heygen_valid_metadata(jsonb) to service_role;
grant execute on function social_cues_private.heygen_valid_public_profile(jsonb) to service_role;
grant execute on function social_cues_private.heygen_valid_request_arguments(text, jsonb) to service_role;
grant execute on function social_cues_private.heygen_valid_operation_safe_result(jsonb) to service_role;
grant execute on function social_cues_private.heygen_account_json(uuid, uuid) to service_role;
grant execute on function social_cues_private.heygen_job_json(uuid) to service_role;
grant execute on function social_cues_private.heygen_version_json(uuid) to service_role;

revoke all on function public.social_cues_heygen_repository_health() from public, anon, authenticated;
revoke all on function public.social_cues_heygen_oauth_state_issue(uuid, uuid, text, jsonb, jsonb, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_oauth_state_consume(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_oauth_state_cancel(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_connection_commit(uuid, uuid, text, uuid, text, text, text[], jsonb, jsonb, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_account_context(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_account_operation_begin(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_refresh_complete(uuid, uuid, text, text, text, text, text[], jsonb, jsonb, jsonb, text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_disconnect_complete(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_account_operation_fail(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_job_reserve(uuid, uuid, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_job_context(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_job_transition(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_jobs_list(uuid, uuid) from public, anon, authenticated;
revoke all on function public.social_cues_heygen_versions_list(uuid, uuid) from public, anon, authenticated;

grant execute on function public.social_cues_heygen_repository_health() to service_role;
grant execute on function public.social_cues_heygen_oauth_state_issue(uuid, uuid, text, jsonb, jsonb, timestamptz, timestamptz) to service_role;
grant execute on function public.social_cues_heygen_oauth_state_consume(uuid, uuid, text) to service_role;
grant execute on function public.social_cues_heygen_oauth_state_cancel(uuid, uuid, text) to service_role;
grant execute on function public.social_cues_heygen_connection_commit(uuid, uuid, text, uuid, text, text, text[], jsonb, jsonb, jsonb, text, timestamptz, timestamptz) to service_role;
grant execute on function public.social_cues_heygen_account_context(uuid, uuid) to service_role;
grant execute on function public.social_cues_heygen_account_operation_begin(uuid, uuid, text, text, text) to service_role;
grant execute on function public.social_cues_heygen_refresh_complete(uuid, uuid, text, text, text, text, text[], jsonb, jsonb, jsonb, text, timestamptz, timestamptz) to service_role;
grant execute on function public.social_cues_heygen_disconnect_complete(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.social_cues_heygen_account_operation_fail(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.social_cues_heygen_job_reserve(uuid, uuid, text, text, text, jsonb, uuid, uuid) to service_role;
grant execute on function public.social_cues_heygen_job_context(uuid, uuid, uuid) to service_role;
grant execute on function public.social_cues_heygen_job_transition(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.social_cues_heygen_jobs_list(uuid, uuid) to service_role;
grant execute on function public.social_cues_heygen_versions_list(uuid, uuid) to service_role;

commit;
-- END SOCIAL CUES HEYGEN DURABLE PERSISTENCE
-- BEGIN SOCIAL CUES HEYGEN DURABLE PERSISTENCE HARDENING (exact standalone migration)
begin;

create index if not exists heygen_oauth_states_connected_account_idx
  on social_cues_private.heygen_oauth_states(connected_account_id);

alter table social_cues_private.heygen_oauth_states enable row level security;
alter table social_cues_private.heygen_oauth_states force row level security;
alter table social_cues_private.heygen_operation_receipts enable row level security;
alter table social_cues_private.heygen_operation_receipts force row level security;

drop policy if exists "client roles cannot access heygen oauth states"
  on social_cues_private.heygen_oauth_states;
create policy "client roles cannot access heygen oauth states"
  on social_cues_private.heygen_oauth_states
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "client roles cannot access heygen operation receipts"
  on social_cues_private.heygen_operation_receipts;
create policy "client roles cannot access heygen operation receipts"
  on social_cues_private.heygen_operation_receipts
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

revoke all on schema social_cues_private from public, anon, authenticated;
revoke all on table
  social_cues_private.heygen_oauth_states,
  social_cues_private.heygen_operation_receipts
from public, anon, authenticated;

commit;
-- END SOCIAL CUES HEYGEN DURABLE PERSISTENCE HARDENING
