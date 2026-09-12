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
