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
