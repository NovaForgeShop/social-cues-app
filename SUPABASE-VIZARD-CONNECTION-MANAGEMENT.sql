-- Social Cues workspace-owned Vizard connection management.
-- This migration is additive and must be applied only after aggregate conflict review.

begin;

-- The schema has no soft-delete column on connected_accounts, so every exact
-- Vizard row is current, including a retained disconnected row.
do $migration$
declare
  v_conflict_count bigint;
begin
  select pg_catalog.count(*)
  into v_conflict_count
  from (
    select ca.workspace_id
    from public.connected_accounts ca
    where ca.provider = 'vizard'
      and ca.platform = 'vizard'
    group by ca.workspace_id
    having pg_catalog.count(*) > 1
  ) conflicts;

  if v_conflict_count > 0 then
    raise exception using
      errcode = '23505',
      message = 'VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP';
  end if;

  select pg_catalog.count(*)
  into v_conflict_count
  from public.connected_accounts ca
  where (ca.provider = 'vizard' or ca.platform = 'vizard')
    and not (ca.provider = 'vizard' and ca.platform = 'vizard');

  if v_conflict_count > 0 then
    raise exception using
      errcode = '23514',
      message = 'VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP';
  end if;

  select pg_catalog.count(*)
  into v_conflict_count
  from public.provider_tokens pt
  join public.connected_accounts ca on ca.id = pt.connected_account_id
  where ca.provider = 'vizard'
    and ca.platform = 'vizard'
    and pt.token_kind = 'api_key'
    and (
      pt.provider <> 'vizard'
      or pt.workspace_id <> ca.workspace_id
    );

  if v_conflict_count > 0 then
    raise exception using
      errcode = '23514',
      message = 'VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'social_cues_manage_vizard_connection'
      and pg_catalog.oidvectortypes(p.proargtypes) <> 'uuid, uuid, text, jsonb'
  ) then
    raise exception using
      errcode = '42725',
      message = 'VIZARD_CONNECTION_MIGRATION_REQUIRES_CLEANUP';
  end if;
end;
$migration$;

create unique index if not exists connected_accounts_workspace_vizard_current_uidx
  on public.connected_accounts(workspace_id)
  where provider = 'vizard' and platform = 'vizard';

-- IF NOT EXISTS is followed by structured catalog verification so a relation
-- with the same name can never silently weaken the Vizard account invariant.
do $index_guard$
declare
  v_index_oid oid;
  v_definition_matches boolean;
begin
  select
    index_relation.oid,
    (
      index_relation.relkind = 'i'
      and target_relation.oid = 'public.connected_accounts'::regclass
      and index_catalog.indisunique
      and index_catalog.indisvalid
      and index_catalog.indisready
      and index_catalog.indnkeyatts = 1
      and index_catalog.indnatts = 1
      and index_catalog.indexprs is null
      and index_catalog.indpred is not null
      and indexed_attribute.attname = 'workspace_id'
      and access_method.amname = 'btree'
      and pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.pg_get_expr(index_catalog.indpred, index_catalog.indrelid, true),
          '::text',
          '',
          'g'
        ),
        '[[:space:]()]',
        '',
        'g'
      ) = 'provider=''vizard''ANDplatform=''vizard'''
    )
  into v_index_oid, v_definition_matches
  from pg_catalog.pg_class index_relation
  join pg_catalog.pg_namespace index_namespace
    on index_namespace.oid = index_relation.relnamespace
  left join pg_catalog.pg_index index_catalog
    on index_catalog.indexrelid = index_relation.oid
  left join pg_catalog.pg_class target_relation
    on target_relation.oid = index_catalog.indrelid
  left join pg_catalog.pg_am access_method
    on access_method.oid = index_relation.relam
  left join pg_catalog.pg_attribute indexed_attribute
    on indexed_attribute.attrelid = index_catalog.indrelid
    and indexed_attribute.attnum = index_catalog.indkey[0]
  where index_namespace.nspname = 'public'
    and index_relation.relname = 'connected_accounts_workspace_vizard_current_uidx'
  limit 1;

  if v_index_oid is null or not coalesce(v_definition_matches, false) then
    raise exception using
      errcode = '23514',
      message = 'VIZARD_CONNECTION_INDEX_DEFINITION_CONFLICT';
  end if;
end;
$index_guard$;

comment on index public.connected_accounts_workspace_vizard_current_uidx is
  'Allows one retained current Vizard account per workspace, whether pending, connected, or disconnected.';

-- provider_tokens already has UNIQUE (connected_account_id, token_kind). Together
-- with the Vizard account index, that existing stronger constraint permits at most
-- one Vizard api_key token for the stable account. Replacement updates that row;
-- disconnect deletes it because provider_tokens has no revoked/deleted lifecycle.
comment on constraint provider_tokens_connected_account_id_token_kind_key
  on public.provider_tokens is
  'Permits at most one token of each kind per connected account, including one Vizard api_key.';

create or replace function public.social_cues_manage_vizard_connection(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_action text,
  p_encrypted_token jsonb default null
)
returns table (
  connected_account_id uuid,
  workspace_id uuid,
  provider text,
  platform text,
  connection_state text,
  verification_state text,
  connected_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_action text;
  v_membership_role text;
  v_account public.connected_accounts%rowtype;
  v_token public.provider_tokens%rowtype;
  v_account_created boolean := false;
  v_token_created boolean := false;
  v_result text;
begin
  if p_actor_user_id is null or p_workspace_id is null then
    raise exception using
      errcode = '42501',
      message = 'VIZARD_CONNECTION_NOT_AUTHORIZED';
  end if;

  v_action := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  if v_action not in ('connect', 'replace', 'disconnect') then
    raise exception using
      errcode = '22023',
      message = 'VIZARD_CONNECTION_ACTION_INVALID';
  end if;

  if v_action in ('connect', 'replace') then
    if p_encrypted_token is null
      or pg_catalog.jsonb_typeof(p_encrypted_token) <> 'object'
      or p_encrypted_token <> pg_catalog.jsonb_strip_nulls(p_encrypted_token)
      or not (p_encrypted_token ?& array['alg', 'iv', 'tag', 'value'])
      or (p_encrypted_token - array['alg', 'iv', 'tag', 'value']) <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(p_encrypted_token->'alg') <> 'string'
      or pg_catalog.jsonb_typeof(p_encrypted_token->'iv') <> 'string'
      or pg_catalog.jsonb_typeof(p_encrypted_token->'tag') <> 'string'
      or pg_catalog.jsonb_typeof(p_encrypted_token->'value') <> 'string'
      or p_encrypted_token->>'alg' <> 'aes-256-gcm'
      or pg_catalog.length(p_encrypted_token->>'iv') <> 16
      or not (p_encrypted_token->>'iv' ~ '^[A-Za-z0-9_-]{16}$')
      or pg_catalog.length(p_encrypted_token->>'tag') <> 22
      or not (p_encrypted_token->>'tag' ~ '^[A-Za-z0-9_-]{22}$')
      or pg_catalog.length(p_encrypted_token->>'value') not between 1 and 4096
      or not (p_encrypted_token->>'value' ~ '^[A-Za-z0-9_-]+$') then
      raise exception using
        errcode = '22023',
        message = 'VIZARD_CONNECTION_ENVELOPE_INVALID';
    end if;
  elsif p_encrypted_token is not null then
    raise exception using
      errcode = '22023',
      message = 'VIZARD_CONNECTION_ENVELOPE_UNEXPECTED';
  end if;

  -- A membership row is the active-membership record in the current schema.
  -- FOR SHARE prevents role change or membership deletion during this operation.
  select pg_catalog.lower(wm.role)
  into v_membership_role
  from public.workspace_members wm
  where wm.workspace_id = p_workspace_id
    and wm.user_id = p_actor_user_id
  for share;

  if v_membership_role is null or v_membership_role not in ('owner', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'VIZARD_CONNECTION_NOT_AUTHORIZED';
  end if;

  -- Serialize every Vizard mutation for a workspace for the current transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text || ':vizard', 0)
  );

  if exists (
    select 1
    from public.connected_accounts ca
    where ca.workspace_id = p_workspace_id
      and (ca.provider = 'vizard' or ca.platform = 'vizard')
      and not (ca.provider = 'vizard' and ca.platform = 'vizard')
  ) then
    raise exception using
      errcode = '23514',
      message = 'VIZARD_CONNECTION_CONFLICT';
  end if;

  select ca.*
  into v_account
  from public.connected_accounts ca
  where ca.workspace_id = p_workspace_id
    and ca.provider = 'vizard'
    and ca.platform = 'vizard'
  for update;

  if v_action in ('connect', 'replace')
    and v_account.id is not null
    and v_account.status not in ('not_connected', 'pending_verification', 'connected') then
    raise exception using
      errcode = '23514',
      message = 'VIZARD_CONNECTION_CONFLICT';
  end if;

  if v_action = 'disconnect' and v_account.id is null then
    insert into public.audit_logs (
      workspace_id,
      user_id,
      event_type,
      provider,
      platform,
      target_id,
      metadata
    ) values (
      p_workspace_id,
      p_actor_user_id,
      'vizard.connection.disconnected',
      'vizard',
      'vizard',
      null,
      pg_catalog.jsonb_build_object(
        'action', 'disconnect',
        'result', 'already_disconnected',
        'connection_state', 'not_connected',
        'verification_state', 'not_verified'
      )
    );

    return query
    select
      null::uuid,
      p_workspace_id,
      'vizard'::text,
      'vizard'::text,
      'not_connected'::text,
      'not_verified'::text,
      null::timestamptz,
      null::timestamptz,
      null::timestamptz;
    return;
  end if;

  if v_action = 'connect' and v_account.id is null then
    insert into public.connected_accounts (
      workspace_id,
      user_id,
      provider,
      platform,
      provider_account_id,
      display_name,
      handle,
      status,
      scopes,
      public_profile,
      connected_at,
      last_sync_at
    ) values (
      p_workspace_id,
      p_actor_user_id,
      'vizard',
      'vizard',
      null,
      'Vizard',
      null,
      'pending_verification',
      '{}'::text[],
      pg_catalog.jsonb_build_object(
        'connection_method', 'api_key',
        'verification_state', 'pending'
      ),
      null,
      null
    )
    returning * into v_account;
    v_account_created := true;
  elsif v_action = 'replace' and v_account.id is null then
    raise exception using
      errcode = 'P0001',
      message = 'VIZARD_CONNECTION_UNAVAILABLE';
  end if;

  if v_account.id is not null then
    select pt.*
    into v_token
    from public.provider_tokens pt
    where pt.connected_account_id = v_account.id
      and pt.token_kind = 'api_key'
    for update;

    if v_token.id is not null and (
      v_token.workspace_id <> p_workspace_id
      or v_token.provider <> 'vizard'
      or (v_token.token_type is not null and v_token.token_type <> 'api_key')
      or v_token.encrypted_refresh_token is not null
      or (
        v_action in ('connect', 'replace')
        and v_account.status = 'not_connected'
      )
    ) then
      raise exception using
        errcode = '23514',
        message = 'VIZARD_CONNECTION_CONFLICT';
    end if;
  end if;

  if v_action = 'connect' then
    if v_token.id is null then
      insert into public.provider_tokens (
        connected_account_id,
        workspace_id,
        user_id,
        provider,
        token_kind,
        encrypted_token,
        encrypted_refresh_token,
        token_type,
        scopes,
        expires_at,
        refresh_expires_at
      ) values (
        v_account.id,
        p_workspace_id,
        p_actor_user_id,
        'vizard',
        'api_key',
        p_encrypted_token,
        null,
        'api_key',
        '{}'::text[],
        null,
        null
      )
      returning * into v_token;
      v_token_created := true;
    elsif v_token.encrypted_token <> p_encrypted_token then
      raise exception using
        errcode = '23505',
        message = 'VIZARD_CONNECTION_ALREADY_STORED';
    end if;

    if v_account_created or v_token_created then
      update public.connected_accounts ca
      set user_id = p_actor_user_id,
          status = 'pending_verification',
          scopes = '{}'::text[],
          public_profile = pg_catalog.jsonb_build_object(
            'connection_method', 'api_key',
            'verification_state', 'pending'
          ),
          connected_at = null,
          last_sync_at = null,
          updated_at = pg_catalog.now()
      where ca.id = v_account.id
      returning * into v_account;
      v_result := case when v_account_created then 'created' else 'reconnected' end;
    else
      v_result := 'already_stored';
    end if;
  elsif v_action = 'replace' then
    if v_token.id is null then
      raise exception using
        errcode = 'P0001',
        message = 'VIZARD_CONNECTION_UNAVAILABLE';
    end if;

    update public.provider_tokens pt
    set workspace_id = p_workspace_id,
        user_id = p_actor_user_id,
        provider = 'vizard',
        encrypted_token = p_encrypted_token,
        encrypted_refresh_token = null,
        token_type = 'api_key',
        scopes = '{}'::text[],
        expires_at = null,
        refresh_expires_at = null,
        updated_at = pg_catalog.now()
    where pt.id = v_token.id
    returning * into v_token;

    update public.connected_accounts ca
    set user_id = p_actor_user_id,
        status = 'pending_verification',
        scopes = '{}'::text[],
        public_profile = pg_catalog.jsonb_build_object(
          'connection_method', 'api_key',
          'verification_state', 'pending'
        ),
        connected_at = null,
        last_sync_at = null,
        updated_at = pg_catalog.now()
    where ca.id = v_account.id
    returning * into v_account;
    v_result := 'replaced';
  else
    delete from public.provider_tokens pt
    where pt.connected_account_id = v_account.id
      and pt.token_kind = 'api_key';

    update public.connected_accounts ca
    set user_id = p_actor_user_id,
        status = 'not_connected',
        scopes = '{}'::text[],
        public_profile = pg_catalog.jsonb_build_object(
          'connection_method', 'api_key',
          'verification_state', 'not_verified'
        ),
        connected_at = null,
        last_sync_at = null,
        updated_at = pg_catalog.now()
    where ca.id = v_account.id
    returning * into v_account;
    v_result := 'disconnected';
  end if;

  insert into public.audit_logs (
    workspace_id,
    user_id,
    event_type,
    provider,
    platform,
    target_id,
    metadata
  ) values (
    p_workspace_id,
    p_actor_user_id,
    'vizard.connection.' || case
      when v_action = 'connect' then 'connected'
      when v_action = 'replace' then 'replaced'
      else 'disconnected'
    end,
    'vizard',
    'vizard',
    v_account.id::text,
    pg_catalog.jsonb_build_object(
      'action', v_action,
      'result', v_result,
      'connection_state', v_account.status,
      'verification_state', case
        when v_account.status = 'pending_verification' then 'pending'
        else 'not_verified'
      end
    )
  );

  return query
  select
    v_account.id,
    v_account.workspace_id,
    'vizard'::text,
    'vizard'::text,
    v_account.status,
    case
      when v_account.status = 'pending_verification' then 'pending'
      else 'not_verified'
    end,
    v_account.connected_at,
    v_account.created_at,
    v_account.updated_at;
end;
$function$;

alter function public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)
  owner to postgres;

comment on function public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb) is
  'Atomically manages one workspace-owned Vizard ciphertext envelope after exact owner/admin membership revalidation.';

revoke all on function public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.social_cues_manage_vizard_connection(uuid, uuid, text, jsonb)
  to service_role;

commit;
