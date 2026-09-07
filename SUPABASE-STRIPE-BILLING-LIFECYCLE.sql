-- Social Cues Stripe B0 workspace billing persistence.
-- Additive, replay-safe, and intentionally independent of application routes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local idle_in_transaction_session_timeout = '60s';

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('social-cues:stripe-b0:v1:migration', 0)
);

-- Session-private helpers make the compatibility checks concise. They never
-- become persistent database API objects.
create or replace function pg_temp.social_cues_b0_relation_fingerprint(p_relation regclass)
returns text
language sql
stable
set search_path = ''
as $fingerprint$
  select pg_catalog.md5(pg_catalog.concat_ws(E'\n',
    (
      select pg_catalog.concat_ws('|',
        n.nspname,
        c.relname,
        c.relkind,
        owner_role.rolname,
        c.relrowsecurity::text,
        c.relforcerowsecurity::text,
        coalesce(pg_catalog.obj_description(c.oid, 'pg_class'), '')
      )
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_roles owner_role on owner_role.oid = c.relowner
      where c.oid = p_relation
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          a.attnum::text,
          a.attname,
          pg_catalog.format_type(a.atttypid, a.atttypmod),
          a.attnotnull::text,
          a.attidentity,
          a.attgenerated,
          coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid, true), ''),
          coalesce(pg_catalog.col_description(a.attrelid, a.attnum), '')
        ),
        E'\n' order by a.attnum
      )
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = p_relation
        and a.attnum > 0
        and not a.attisdropped
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          con.conname,
          con.contype,
          con.condeferrable::text,
          con.condeferred::text,
          pg_catalog.pg_get_constraintdef(con.oid, true),
          coalesce(pg_catalog.obj_description(con.oid, 'pg_constraint'), '')
        ),
        E'\n' order by con.conname
      )
      from pg_catalog.pg_constraint con
      where con.conrelid = p_relation
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          index_relation.relname,
          pg_catalog.pg_get_indexdef(index_relation.oid, 0, true),
          coalesce(pg_catalog.obj_description(index_relation.oid, 'pg_class'), '')
        ),
        E'\n' order by index_relation.relname
      )
      from pg_catalog.pg_index index_catalog
      join pg_catalog.pg_class index_relation
        on index_relation.oid = index_catalog.indexrelid
      where index_catalog.indrelid = p_relation
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          trigger_catalog.tgname,
          pg_catalog.pg_get_triggerdef(trigger_catalog.oid, true),
          coalesce(pg_catalog.obj_description(trigger_catalog.oid, 'pg_trigger'), '')
        ),
        E'\n' order by trigger_catalog.tgname
      )
      from pg_catalog.pg_trigger trigger_catalog
      where trigger_catalog.tgrelid = p_relation
        and not trigger_catalog.tgisinternal
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          policy_catalog.polname,
          policy_catalog.polcmd,
          policy_catalog.polpermissive::text,
          coalesce((
            select pg_catalog.string_agg(role_catalog.rolname, ',' order by role_catalog.rolname)
            from pg_catalog.unnest(policy_catalog.polroles) role_oid(oid)
            join pg_catalog.pg_roles role_catalog on role_catalog.oid = role_oid.oid
          ), ''),
          coalesce(pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid, true), ''),
          coalesce(pg_catalog.pg_get_expr(policy_catalog.polwithcheck, policy_catalog.polrelid, true), '')
        ),
        E'\n' order by policy_catalog.polname
      )
      from pg_catalog.pg_policy policy_catalog
      where policy_catalog.polrelid = p_relation
    ),
    (
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          coalesce(grantee_role.rolname, 'PUBLIC'),
          acl_entry.privilege_type,
          acl_entry.is_grantable::text,
          grantor_role.rolname
        ),
        E'\n' order by coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type
      )
      from pg_catalog.pg_class relation_catalog
      cross join lateral pg_catalog.aclexplode(
        coalesce(relation_catalog.relacl, pg_catalog.acldefault('r', relation_catalog.relowner))
      ) acl_entry
      left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl_entry.grantee
      join pg_catalog.pg_roles grantor_role on grantor_role.oid = acl_entry.grantor
      where relation_catalog.oid = p_relation
        and acl_entry.grantee <> relation_catalog.relowner
    )
  ));
$fingerprint$;

create or replace function pg_temp.social_cues_b0_function_fingerprint(p_function regprocedure)
returns text
language sql
stable
set search_path = ''
as $fingerprint$
  select pg_catalog.md5(pg_catalog.concat_ws(E'\n',
    namespace_catalog.nspname,
    function_catalog.proname,
    pg_catalog.pg_get_function_identity_arguments(function_catalog.oid),
    pg_catalog.pg_get_function_result(function_catalog.oid),
    language_catalog.lanname,
    owner_role.rolname,
    function_catalog.provolatile,
    function_catalog.proparallel,
    function_catalog.proisstrict::text,
    function_catalog.prosecdef::text,
    function_catalog.proleakproof::text,
    coalesce(pg_catalog.array_to_string(function_catalog.proconfig, ','), ''),
    pg_catalog.md5(pg_catalog.replace(
      pg_catalog.replace(function_catalog.prosrc, E'\r\n', E'\n'),
      E'\r', E'\n'
    )),
    coalesce(pg_catalog.obj_description(function_catalog.oid, 'pg_proc'), ''),
    coalesce((
      select pg_catalog.string_agg(
        pg_catalog.concat_ws('|',
          coalesce(grantee_role.rolname, 'PUBLIC'),
          acl_entry.privilege_type,
          acl_entry.is_grantable::text,
          grantor_role.rolname
        ),
        E'\n' order by coalesce(grantee_role.rolname, 'PUBLIC'), acl_entry.privilege_type
      )
      from pg_catalog.aclexplode(
        coalesce(function_catalog.proacl, pg_catalog.acldefault('f', function_catalog.proowner))
      ) acl_entry
      left join pg_catalog.pg_roles grantee_role on grantee_role.oid = acl_entry.grantee
      join pg_catalog.pg_roles grantor_role on grantor_role.oid = acl_entry.grantor
    ), '')
  ))
  from pg_catalog.pg_proc function_catalog
  join pg_catalog.pg_namespace namespace_catalog
    on namespace_catalog.oid = function_catalog.pronamespace
  join pg_catalog.pg_language language_catalog
    on language_catalog.oid = function_catalog.prolang
  join pg_catalog.pg_roles owner_role
    on owner_role.oid = function_catalog.proowner
  where function_catalog.oid = p_function;
$fingerprint$;

do $preflight$
declare
  v_relation regclass;
  v_function regprocedure;
begin
  if pg_catalog.to_regclass('public.workspaces') is null
    or pg_catalog.to_regclass('public.audit_logs') is null
    or pg_catalog.to_regclass('public.webhook_events') is null then
    raise exception using errcode = '42P01', message = 'STRIPE_B0_PREREQUISITE_SCHEMA_REQUIRED';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.workspaces'::regclass
      and a.attname = 'id'
      and a.atttypid = 'uuid'::regtype
      and a.attnotnull
      and not a.attisdropped
  ) then
    raise exception using errcode = '42804', message = 'STRIPE_B0_WORKSPACES_DEFINITION_CONFLICT';
  end if;

  if exists (
    with expected(name, type_name, required_not_null) as (
      values
        ('id', 'uuid', true),
        ('workspace_id', 'uuid', false),
        ('user_id', 'uuid', false),
        ('event_type', 'text', true),
        ('provider', 'text', false),
        ('platform', 'text', false),
        ('target_id', 'text', false),
        ('metadata', 'jsonb', true),
        ('created_at', 'timestamp with time zone', true)
    )
    select 1
    from expected
    left join pg_catalog.pg_attribute a
      on a.attrelid = 'public.audit_logs'::regclass
      and a.attname = expected.name
      and a.attnum > 0
      and not a.attisdropped
    where a.attname is null
      or pg_catalog.format_type(a.atttypid, a.atttypmod) <> expected.type_name
      or a.attnotnull <> expected.required_not_null
  ) then
    raise exception using errcode = '42804', message = 'STRIPE_B0_AUDIT_LOG_DEFINITION_CONFLICT';
  end if;

  if exists (
    with expected(name, type_name, required_not_null) as (
      values
        ('id', 'uuid', true),
        ('provider', 'text', true),
        ('event_id', 'text', true),
        ('event_type', 'text', false),
        ('status', 'text', true),
        ('attempts', 'integer', true),
        ('received_at', 'timestamp with time zone', true),
        ('processed_at', 'timestamp with time zone', false),
        ('last_error', 'text', false)
    )
    select 1
    from expected
    left join pg_catalog.pg_attribute a
      on a.attrelid = 'public.webhook_events'::regclass
      and a.attname = expected.name
      and a.attnum > 0
      and not a.attisdropped
    where a.attname is null
      or pg_catalog.format_type(a.atttypid, a.atttypmod) <> expected.type_name
      or a.attnotnull <> expected.required_not_null
  ) then
    raise exception using errcode = '42804', message = 'STRIPE_B0_WEBHOOK_BASE_DEFINITION_CONFLICT';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.webhook_events'::regclass
      and con.contype = 'u'
      and (
        select pg_catalog.array_agg(a.attname order by key_column.ordinality)
        from pg_catalog.unnest(con.conkey) with ordinality key_column(attnum, ordinality)
        join pg_catalog.pg_attribute a
          on a.attrelid = con.conrelid and a.attnum = key_column.attnum
      ) = array['provider', 'event_id']::name[]
  ) then
    raise exception using errcode = '23514', message = 'STRIPE_B0_WEBHOOK_IDEMPOTENCY_CONSTRAINT_REQUIRED';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class relation_catalog
    join pg_catalog.pg_roles owner_role
      on owner_role.oid = relation_catalog.relowner
    where relation_catalog.oid = 'public.webhook_events'::regclass
      and relation_catalog.relkind = 'r'
      and owner_role.rolname = 'postgres'
      and relation_catalog.relrowsecurity
  ) or exists (
    select 1
    from pg_catalog.pg_class relation_catalog
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        relation_catalog.relacl,
        pg_catalog.acldefault('r', relation_catalog.relowner)
      )
    ) acl_entry
    left join pg_catalog.pg_roles grantee_role
      on grantee_role.oid = acl_entry.grantee
    where relation_catalog.oid = 'public.webhook_events'::regclass
      and (
        acl_entry.grantee = 0
        or grantee_role.rolname in ('anon', 'authenticated')
      )
  ) or not exists (
    select 1
    from pg_catalog.pg_policy policy_catalog
    where policy_catalog.polrelid = 'public.webhook_events'::regclass
      and policy_catalog.polname = 'webhook events are service role only'
      and policy_catalog.polpermissive
      and policy_catalog.polcmd = '*'
      and (
        select pg_catalog.array_agg(role_catalog.rolname order by role_catalog.rolname)
        from pg_catalog.unnest(policy_catalog.polroles) policy_role(role_oid)
        join pg_catalog.pg_roles role_catalog
          on role_catalog.oid = policy_role.role_oid
      ) = array['anon'::name, 'authenticated'::name]
      and pg_catalog.regexp_replace(
        coalesce(pg_catalog.pg_get_expr(policy_catalog.polqual, policy_catalog.polrelid, true), ''),
        '[[:space:]()]', '', 'g'
      ) = 'false'
      and pg_catalog.regexp_replace(
        coalesce(pg_catalog.pg_get_expr(policy_catalog.polwithcheck, policy_catalog.polrelid, true), ''),
        '[[:space:]()]', '', 'g'
      ) = 'false'
  ) or exists (
    select 1
    from pg_catalog.pg_policy policy_catalog
    where policy_catalog.polrelid = 'public.webhook_events'::regclass
      and policy_catalog.polname <> 'webhook events are service role only'
      and (
        0::oid = any(policy_catalog.polroles)
        or exists (
          select 1
          from pg_catalog.unnest(policy_catalog.polroles) policy_role(role_oid)
          join pg_catalog.pg_roles role_catalog
            on role_catalog.oid = policy_role.role_oid
          where role_catalog.rolname in ('anon', 'authenticated')
        )
      )
  ) then
    raise exception using errcode = '42501', message = 'STRIPE_B0_WEBHOOK_SECURITY_PREREQUISITE_CONFLICT';
  end if;

  -- Existing extension objects are accepted only with their exact B0 shapes.
  if exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.webhook_events'::regclass
      and a.attname = 'environment'
      and not a.attisdropped
      and (a.atttypid <> 'text'::regtype or a.attnotnull or a.atthasdef)
  ) or exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.webhook_events'::regclass
      and a.attname = 'workspace_id'
      and not a.attisdropped
      and (a.atttypid <> 'uuid'::regtype or a.attnotnull or a.atthasdef)
  ) or exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = 'public.webhook_events'::regclass
      and a.attname = 'result_code'
      and not a.attisdropped
      and (a.atttypid <> 'text'::regtype or a.attnotnull or a.atthasdef)
  ) or exists (
    select 1
    from pg_catalog.pg_attribute a
    left join pg_catalog.pg_attrdef d
      on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.webhook_events'::regclass
      and a.attname = 'processing_result'
      and not a.attisdropped
      and (
        a.atttypid <> 'jsonb'::regtype
        or not a.attnotnull
        or coalesce(pg_catalog.pg_get_expr(d.adbin, d.adrelid, true), '') <> '''{}''::jsonb'
      )
  ) then
    raise exception using errcode = '42804', message = 'STRIPE_B0_WEBHOOK_EXTENSION_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.webhook_events'::regclass
      and con.conname = 'webhook_events_environment_check'
      and (
        con.contype <> 'c'
        or pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, true),
          '[[:space:]()]|::text', '', 'g'
        ) <> 'CHECKenvironmentISNULLORenvironment=ANYARRAY[''test'',''live'']'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.webhook_events'::regclass
      and con.conname = 'webhook_events_workspace_id_fkey'
      and (
        con.contype <> 'f'
        or con.confrelid <> 'public.workspaces'::regclass
        or con.confdeltype <> 'n'
      )
  ) then
    raise exception using errcode = '23514', message = 'STRIPE_B0_WEBHOOK_CONSTRAINT_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.webhook_events'::regclass
      and con.conname = 'webhook_events_processing_result_safe_check'
      and (
        con.contype <> 'c'
        or pg_catalog.md5(pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, true), '[[:space:]]', '', 'g'
        )) <> '0041cd0dbc78440abd089b4e94cb7cb3'
        or pg_catalog.obj_description(con.oid, 'pg_constraint')
          <> 'social-cues:stripe-b0:v1 sanitized Stripe processing-result metadata'
      )
  ) or exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.webhook_events'::regclass
      and con.conname = 'webhook_events_result_code_safe_check'
      and (
        con.contype <> 'c'
        or pg_catalog.md5(pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, true), '[[:space:]]', '', 'g'
        )) <> '26cdc71d479a0481919a34e8b8b5800e'
        or pg_catalog.obj_description(con.oid, 'pg_constraint')
          <> 'social-cues:stripe-b0:v1 bounded Stripe result code'
      )
  ) then
    raise exception using errcode = '23514', message = 'STRIPE_B0_WEBHOOK_SAFETY_CONSTRAINT_CONFLICT';
  end if;

  if pg_catalog.to_regclass('public.webhook_events_provider_environment_received_idx') is not null
    and pg_catalog.regexp_replace(
      pg_catalog.pg_get_indexdef(
        pg_catalog.to_regclass('public.webhook_events_provider_environment_received_idx'),
        0,
        true
      ),
      '[[:space:]]', '', 'g'
    ) <> 'CREATEINDEXwebhook_events_provider_environment_received_idxONwebhook_eventsUSINGbtree(provider,environment,received_atDESC)' then
    raise exception using errcode = '42P07', message = 'STRIPE_B0_WEBHOOK_INDEX_CONFLICT';
  end if;

  v_relation := pg_catalog.to_regclass('public.stripe_billing_bindings');
  if v_relation is not null
    and pg_temp.social_cues_b0_relation_fingerprint(v_relation)
      <> '89b16a84e4f3a463af9fe819256019e7' then
    raise exception using errcode = '42P07', message = 'STRIPE_B0_BINDINGS_DEFINITION_CONFLICT';
  elsif v_relation is null and (
    pg_catalog.to_regclass('public.stripe_billing_bindings_environment_subscription_uidx') is not null
    or pg_catalog.to_regclass('public.stripe_billing_bindings_workspace_idx') is not null
  ) then
    raise exception using errcode = '42P07', message = 'STRIPE_B0_BINDINGS_DEPENDENCY_CONFLICT';
  end if;

  v_relation := pg_catalog.to_regclass('public.stripe_checkout_sessions');
  if v_relation is not null
    and pg_temp.social_cues_b0_relation_fingerprint(v_relation)
      <> 'ba0f9cb575217afb17fa5290b1454227' then
    raise exception using errcode = '42P07', message = 'STRIPE_B0_CHECKOUT_DEFINITION_CONFLICT';
  elsif v_relation is null and (
    pg_catalog.to_regclass('public.stripe_checkout_sessions_environment_session_uidx') is not null
    or pg_catalog.to_regclass('public.stripe_checkout_sessions_workspace_created_idx') is not null
  ) then
    raise exception using errcode = '42P07', message = 'STRIPE_B0_CHECKOUT_DEPENDENCY_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_catalog
    join pg_catalog.pg_namespace namespace_catalog
      on namespace_catalog.oid = function_catalog.pronamespace
    where namespace_catalog.nspname = 'public'
      and function_catalog.proname = 'social_cues_enforce_stripe_binding_update'
      and pg_catalog.pg_get_function_identity_arguments(function_catalog.oid) <> ''
  ) then
    raise exception using errcode = '42725', message = 'STRIPE_B0_FUNCTION_OVERLOAD_CONFLICT';
  end if;

  v_function := pg_catalog.to_regprocedure('public.social_cues_enforce_stripe_binding_update()');
  if v_function is not null
    and pg_temp.social_cues_b0_function_fingerprint(v_function)
      <> 'aa501295ed151d5f6da1bc03de0f4ab6' then
    raise exception using errcode = '42723', message = 'STRIPE_B0_FUNCTION_DEFINITION_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_catalog
    join pg_catalog.pg_namespace namespace_catalog
      on namespace_catalog.oid = function_catalog.pronamespace
    where namespace_catalog.nspname = 'public'
      and function_catalog.proname = 'social_cues_enforce_stripe_checkout_identity'
      and pg_catalog.pg_get_function_identity_arguments(function_catalog.oid) <> ''
  ) then
    raise exception using errcode = '42725', message = 'STRIPE_B0_FUNCTION_OVERLOAD_CONFLICT';
  end if;

  v_function := pg_catalog.to_regprocedure('public.social_cues_enforce_stripe_checkout_identity()');
  if v_function is not null
    and pg_temp.social_cues_b0_function_fingerprint(v_function)
      <> '6e4a6b739f8a0073dc3e2bc3ff0a2fb0' then
    raise exception using errcode = '42723', message = 'STRIPE_B0_FUNCTION_DEFINITION_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_catalog
    join pg_catalog.pg_namespace namespace_catalog
      on namespace_catalog.oid = function_catalog.pronamespace
    where namespace_catalog.nspname = 'public'
      and function_catalog.proname = 'social_cues_reconcile_stripe_binding'
      and pg_catalog.oidvectortypes(function_catalog.proargtypes)
        <> 'uuid, text, text, text, text, text, text, timestamp with time zone, timestamp with time zone, boolean, bigint, text'
  ) then
    raise exception using errcode = '42725', message = 'STRIPE_B0_FUNCTION_OVERLOAD_CONFLICT';
  end if;

  v_function := pg_catalog.to_regprocedure(
    'public.social_cues_reconcile_stripe_binding(uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text)'
  );
  if v_function is not null
    and pg_temp.social_cues_b0_function_fingerprint(v_function)
      <> '367a228090a0e1f9b3b5d57619ae3b8e' then
    raise exception using errcode = '42723', message = 'STRIPE_B0_FUNCTION_DEFINITION_CONFLICT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc function_catalog
    join pg_catalog.pg_namespace namespace_catalog
      on namespace_catalog.oid = function_catalog.pronamespace
    where namespace_catalog.nspname = 'public'
      and function_catalog.proname = 'social_cues_claim_stripe_webhook_event'
      and pg_catalog.oidvectortypes(function_catalog.proargtypes)
        <> 'uuid, text, text, text, integer'
  ) then
    raise exception using errcode = '42725', message = 'STRIPE_B0_FUNCTION_OVERLOAD_CONFLICT';
  end if;

  v_function := pg_catalog.to_regprocedure(
    'public.social_cues_claim_stripe_webhook_event(uuid,text,text,text,integer)'
  );
  if v_function is not null
    and pg_temp.social_cues_b0_function_fingerprint(v_function)
      <> '098962f257bd503e99e2dee9890dac9c' then
    raise exception using errcode = '42723', message = 'STRIPE_B0_FUNCTION_DEFINITION_CONFLICT';
  end if;
end;
$preflight$;

create table if not exists public.stripe_billing_bindings (
  id uuid not null default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null,
  stripe_environment text not null,
  stripe_customer_id text not null,
  stripe_subscription_id text,
  stripe_price_id text,
  plan_id text,
  subscription_status text not null default 'not_started',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  latest_event_created bigint not null default 0,
  latest_event_id text,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint stripe_billing_bindings_pkey primary key (id),
  constraint stripe_billing_bindings_workspace_id_fkey
    foreign key (workspace_id) references public.workspaces(id) on delete restrict,
  constraint stripe_billing_bindings_workspace_environment_key
    unique (workspace_id, stripe_environment),
  constraint stripe_billing_bindings_environment_customer_key
    unique (stripe_environment, stripe_customer_id),
  constraint stripe_billing_bindings_environment_check
    check (stripe_environment in ('test', 'live')),
  constraint stripe_billing_bindings_customer_id_check
    check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{6,248}$'),
  constraint stripe_billing_bindings_subscription_id_check
    check (stripe_subscription_id is null or stripe_subscription_id ~ '^sub_[A-Za-z0-9]{6,248}$'),
  constraint stripe_billing_bindings_price_id_check
    check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]{6,246}$'),
  constraint stripe_billing_bindings_plan_id_check
    check (plan_id is null or plan_id in ('business', 'growth', 'agency')),
  constraint stripe_billing_bindings_status_check
    check (subscription_status in (
      'not_started', 'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )),
  constraint stripe_billing_bindings_state_check
    check (
      (
        stripe_subscription_id is null
        and stripe_price_id is null
        and plan_id is null
        and current_period_start is null
        and current_period_end is null
        and cancel_at_period_end = false
        and subscription_status in ('not_started', 'incomplete_expired', 'canceled', 'unpaid')
      )
      or
      (
        stripe_subscription_id is not null
        and stripe_price_id is not null
        and plan_id is not null
        and subscription_status in ('incomplete', 'trialing', 'active', 'past_due', 'paused')
      )
    ),
  constraint stripe_billing_bindings_period_check
    check (
      (current_period_start is null and current_period_end is null)
      or (
        current_period_start is not null
        and current_period_end is not null
        and current_period_end > current_period_start
      )
    ),
  constraint stripe_billing_bindings_event_check
    check (
      latest_event_created >= 0
      and (
        (latest_event_created = 0 and latest_event_id is null)
        or (latest_event_created > 0 and latest_event_id ~ '^evt_[A-Za-z0-9]{6,248}$')
      )
    )
);

alter table public.stripe_billing_bindings owner to postgres;
comment on table public.stripe_billing_bindings is
  'social-cues:stripe-b0:v1 durable workspace/environment customer binding with mutable current subscription state';

create unique index if not exists stripe_billing_bindings_environment_subscription_uidx
  on public.stripe_billing_bindings(stripe_environment, stripe_subscription_id)
  where stripe_subscription_id is not null;
comment on index public.stripe_billing_bindings_environment_subscription_uidx is
  'social-cues:stripe-b0:v1 one current subscription binding per Stripe environment';

create index if not exists stripe_billing_bindings_workspace_idx
  on public.stripe_billing_bindings(workspace_id);
comment on index public.stripe_billing_bindings_workspace_idx is
  'social-cues:stripe-b0:v1 workspace lookup for environment-separated billing bindings';

create table if not exists public.stripe_checkout_sessions (
  id uuid not null default pg_catalog.gen_random_uuid(),
  workspace_id uuid not null,
  stripe_environment text not null,
  stripe_session_id text,
  idempotency_key text not null,
  requested_plan_id text not null,
  lifecycle_status text not null default 'reserved',
  result_code text,
  safe_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint stripe_checkout_sessions_pkey primary key (id),
  constraint stripe_checkout_sessions_workspace_id_fkey
    foreign key (workspace_id) references public.workspaces(id) on delete restrict,
  constraint stripe_checkout_sessions_workspace_environment_idempotency_key
    unique (workspace_id, stripe_environment, idempotency_key),
  constraint stripe_checkout_sessions_environment_check
    check (stripe_environment in ('test', 'live')),
  constraint stripe_checkout_sessions_session_id_check
    check (stripe_session_id is null or stripe_session_id ~ '^cs_[A-Za-z0-9_]{6,247}$'),
  constraint stripe_checkout_sessions_idempotency_key_check
    check (
      idempotency_key = pg_catalog.btrim(idempotency_key)
      and pg_catalog.length(idempotency_key) between 16 and 255
    ),
  constraint stripe_checkout_sessions_plan_id_check
    check (requested_plan_id in ('business', 'growth', 'agency')),
  constraint stripe_checkout_sessions_lifecycle_status_check
    check (lifecycle_status in ('reserved', 'created', 'completed', 'expired', 'failed')),
  constraint stripe_checkout_sessions_result_code_check
    check (
      result_code is null
      or (
        result_code = pg_catalog.btrim(result_code)
        and pg_catalog.length(result_code) between 1 and 80
      )
    ),
  constraint stripe_checkout_sessions_safe_result_check
    check (
      pg_catalog.jsonb_typeof(safe_result) = 'object'
      and pg_catalog.octet_length(safe_result::text) <= 4096
      and not pg_catalog.jsonb_path_exists(
        safe_result,
        '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(secret|token|api.?key|authorization|raw|payload|customer.?id|subscription.?id|price.?id|session.?id)" flag "i")'::pg_catalog.jsonpath
      )
    )
);

alter table public.stripe_checkout_sessions owner to postgres;
comment on table public.stripe_checkout_sessions is
  'social-cues:stripe-b0:v1 service-only checkout idempotency ledger without provider execution';

create unique index if not exists stripe_checkout_sessions_environment_session_uidx
  on public.stripe_checkout_sessions(stripe_environment, stripe_session_id)
  where stripe_session_id is not null;
comment on index public.stripe_checkout_sessions_environment_session_uidx is
  'social-cues:stripe-b0:v1 one checkout session identity per Stripe environment';

create index if not exists stripe_checkout_sessions_workspace_created_idx
  on public.stripe_checkout_sessions(workspace_id, created_at desc);
comment on index public.stripe_checkout_sessions_workspace_created_idx is
  'social-cues:stripe-b0:v1 workspace checkout ledger chronology';

alter table public.webhook_events
  add column if not exists environment text,
  add column if not exists workspace_id uuid,
  add column if not exists result_code text,
  add column if not exists processing_result jsonb not null default '{}'::jsonb;

do $webhook_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.webhook_events'::regclass
      and conname = 'webhook_events_workspace_id_fkey'
  ) then
    alter table public.webhook_events
      add constraint webhook_events_workspace_id_fkey
      foreign key (workspace_id) references public.workspaces(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.webhook_events'::regclass
      and conname = 'webhook_events_environment_check'
  ) then
    alter table public.webhook_events
      add constraint webhook_events_environment_check
      check (environment is null or environment in ('test', 'live'));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.webhook_events'::regclass
      and conname = 'webhook_events_processing_result_safe_check'
  ) then
    alter table public.webhook_events
      add constraint webhook_events_processing_result_safe_check
      check (
        provider <> 'stripe'
        or (
          pg_catalog.jsonb_typeof(processing_result) = 'object'
          and pg_catalog.octet_length(processing_result::text) <= 4096
          and not pg_catalog.jsonb_path_exists(
            processing_result,
            '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(secret|token|api.?key|authorization|raw|payload|customer.?id|subscription.?id|price.?id|session.?id)" flag "i")'::pg_catalog.jsonpath
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.webhook_events'::regclass
      and conname = 'webhook_events_result_code_safe_check'
  ) then
    alter table public.webhook_events
      add constraint webhook_events_result_code_safe_check
      check (
        provider <> 'stripe'
        or result_code is null
        or (
          result_code = pg_catalog.btrim(result_code)
          and pg_catalog.length(result_code) between 1 and 80
        )
      );
  end if;
end;
$webhook_constraints$;

comment on column public.webhook_events.environment is
  'social-cues:stripe-b0:v1 explicit Stripe test/live boundary; null for non-Stripe predecessor rows';
comment on column public.webhook_events.workspace_id is
  'social-cues:stripe-b0:v1 resolved Social Cues workspace when a Stripe event is claimed';
comment on column public.webhook_events.result_code is
  'social-cues:stripe-b0:v1 sanitized processing outcome code';
comment on column public.webhook_events.processing_result is
  'social-cues:stripe-b0:v1 sanitized result metadata only; never raw provider payloads';
comment on constraint webhook_events_workspace_id_fkey on public.webhook_events is
  'social-cues:stripe-b0:v1 optional workspace binding preserves webhook history on workspace deletion';
comment on constraint webhook_events_environment_check on public.webhook_events is
  'social-cues:stripe-b0:v1 explicit test/live boundary for Stripe rows';
comment on constraint webhook_events_processing_result_safe_check on public.webhook_events is
  'social-cues:stripe-b0:v1 sanitized Stripe processing-result metadata';
comment on constraint webhook_events_result_code_safe_check on public.webhook_events is
  'social-cues:stripe-b0:v1 bounded Stripe result code';

create index if not exists webhook_events_provider_environment_received_idx
  on public.webhook_events(provider, environment, received_at desc);
comment on index public.webhook_events_provider_environment_received_idx is
  'social-cues:stripe-b0:v1 environment-separated webhook claim lookup';

create or replace function public.social_cues_enforce_stripe_binding_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.workspace_id is distinct from old.workspace_id
    or new.stripe_environment is distinct from old.stripe_environment
    or new.stripe_customer_id is distinct from old.stripe_customer_id
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'STRIPE_B0_IMMUTABLE_BINDING_CONFLICT';
  end if;

  if (
    new.stripe_subscription_id is distinct from old.stripe_subscription_id
    or new.stripe_price_id is distinct from old.stripe_price_id
    or new.plan_id is distinct from old.plan_id
    or new.subscription_status is distinct from old.subscription_status
    or new.current_period_start is distinct from old.current_period_start
    or new.current_period_end is distinct from old.current_period_end
    or new.cancel_at_period_end is distinct from old.cancel_at_period_end
    or new.latest_event_created is distinct from old.latest_event_created
    or new.latest_event_id is distinct from old.latest_event_id
  ) and (
    current_user <> 'postgres'
    or coalesce(pg_catalog.current_setting('social_cues.stripe_reconcile', true), '') <> 'v1'
  ) then
    raise exception using errcode = '42501', message = 'STRIPE_B0_RECONCILIATION_REQUIRED';
  end if;

  return new;
end;
$function$;

alter function public.social_cues_enforce_stripe_binding_update() owner to postgres;
comment on function public.social_cues_enforce_stripe_binding_update() is
  'social-cues:stripe-b0:v1 guards durable identity and confines lifecycle mutation to reconciliation';
revoke all on function public.social_cues_enforce_stripe_binding_update()
  from public, anon, authenticated, service_role;

create or replace function public.social_cues_enforce_stripe_checkout_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if new.stripe_session_id is not null
    and new.stripe_session_id !~ '^cs_[A-Za-z0-9_]{6,247}$' then
    raise exception using errcode = '22023', message = 'STRIPE_B0_CHECKOUT_SESSION_ID_INVALID';
  end if;

  if new.result_code is not null
    and (
      new.result_code <> pg_catalog.btrim(new.result_code)
      or pg_catalog.length(new.result_code) not between 1 and 80
    ) then
    raise exception using errcode = '22023', message = 'STRIPE_B0_CHECKOUT_RESULT_CODE_INVALID';
  end if;

  if pg_catalog.jsonb_typeof(new.safe_result) <> 'object'
    or pg_catalog.octet_length(new.safe_result::text) > 4096
    or pg_catalog.jsonb_path_exists(
      new.safe_result,
      '$.** ? (@.type() == "object").keyvalue() ? (@.key like_regex "(secret|token|api.?key|authorization|raw|payload|customer.?id|subscription.?id|price.?id|session.?id)" flag "i")'::pg_catalog.jsonpath
    ) then
    raise exception using errcode = '22023', message = 'STRIPE_B0_CHECKOUT_SAFE_RESULT_INVALID';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.workspace_id is distinct from old.workspace_id
      or new.stripe_environment is distinct from old.stripe_environment
      or new.idempotency_key is distinct from old.idempotency_key
      or new.requested_plan_id is distinct from old.requested_plan_id
      or (
        old.stripe_session_id is not null
        and new.stripe_session_id is distinct from old.stripe_session_id
      )
      or new.created_at is distinct from old.created_at then
      raise exception using errcode = '23514', message = 'STRIPE_B0_IMMUTABLE_CHECKOUT_IDENTITY_CONFLICT';
    end if;
  end if;
  return new;
end;
$function$;

alter function public.social_cues_enforce_stripe_checkout_identity() owner to postgres;
comment on function public.social_cues_enforce_stripe_checkout_identity() is
  'social-cues:stripe-b0:v1 guards checkout workspace, environment, plan, and idempotency identity';
revoke all on function public.social_cues_enforce_stripe_checkout_identity()
  from public, anon, authenticated, service_role;

do $triggers$
begin
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.stripe_billing_bindings'::regclass
      and tgname = 'enforce_stripe_billing_binding_update'
      and not tgisinternal
  ) then
    create trigger enforce_stripe_billing_binding_update
      before update on public.stripe_billing_bindings
      for each row execute function public.social_cues_enforce_stripe_binding_update();
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.stripe_checkout_sessions'::regclass
      and tgname = 'enforce_stripe_checkout_session_identity'
      and not tgisinternal
  ) then
    create trigger enforce_stripe_checkout_session_identity
      before insert or update on public.stripe_checkout_sessions
      for each row execute function public.social_cues_enforce_stripe_checkout_identity();
  end if;
end;
$triggers$;

comment on trigger enforce_stripe_billing_binding_update on public.stripe_billing_bindings is
  'social-cues:stripe-b0:v1 immutable customer identity and RPC-only lifecycle mutation';
comment on trigger enforce_stripe_checkout_session_identity on public.stripe_checkout_sessions is
  'social-cues:stripe-b0:v1 immutable checkout idempotency identity';

create or replace function public.social_cues_reconcile_stripe_binding(
  p_workspace_id uuid,
  p_stripe_environment text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan_id text,
  p_subscription_status text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_event_created bigint,
  p_event_id text
)
returns table (
  binding_id uuid,
  workspace_id uuid,
  stripe_environment text,
  plan_id text,
  subscription_status text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  applied boolean,
  result_code text,
  subscription_replaced boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.stripe_billing_bindings%rowtype;
  v_existing_customer_workspace uuid;
  v_database_role text;
  v_jwt_role text;
  v_terminal boolean;
  v_subscription_replaced boolean := false;
  v_result_code text;
begin
  v_database_role := nullif(pg_catalog.current_setting('role', true), 'none');
  v_jwt_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  if v_database_role is distinct from 'service_role'
    or (v_jwt_role is not null and v_jwt_role <> 'service_role') then
    raise exception using errcode = '42501', message = 'STRIPE_B0_SERVICE_ROLE_REQUIRED';
  end if;

  if p_workspace_id is null
    or p_stripe_environment not in ('test', 'live')
    or p_stripe_customer_id is null
    or p_stripe_customer_id !~ '^cus_[A-Za-z0-9]{6,248}$'
    or p_subscription_status not in (
      'not_started', 'incomplete', 'incomplete_expired', 'trialing', 'active',
      'past_due', 'canceled', 'unpaid', 'paused'
    )
    or p_event_created is null
    or p_event_created <= 0
    or p_event_id is null
    or p_event_id !~ '^evt_[A-Za-z0-9]{6,248}$' then
    raise exception using errcode = '22023', message = 'STRIPE_B0_RECONCILIATION_INPUT_INVALID';
  end if;

  v_terminal := p_subscription_status in ('not_started', 'incomplete_expired', 'canceled', 'unpaid');
  if v_terminal then
    if p_stripe_subscription_id is not null
      or p_stripe_price_id is not null
      or p_plan_id is not null
      or p_current_period_start is not null
      or p_current_period_end is not null
      or coalesce(p_cancel_at_period_end, false) then
      raise exception using errcode = '22023', message = 'STRIPE_B0_TERMINAL_STATE_INVALID';
    end if;
  elsif p_stripe_subscription_id is null
    or p_stripe_subscription_id !~ '^sub_[A-Za-z0-9]{6,248}$'
    or p_stripe_price_id is null
    or p_stripe_price_id !~ '^price_[A-Za-z0-9]{6,246}$'
    or p_plan_id not in ('business', 'growth', 'agency')
    or (p_current_period_start is null) <> (p_current_period_end is null)
    or (
      p_current_period_start is not null
      and p_current_period_end <= p_current_period_start
    ) then
    raise exception using errcode = '22023', message = 'STRIPE_B0_SUBSCRIPTION_STATE_INVALID';
  end if;

  if not exists (
    select 1 from public.workspaces workspace_row
    where workspace_row.id = p_workspace_id
    for key share
  ) then
    raise exception using errcode = '23503', message = 'STRIPE_B0_WORKSPACE_REQUIRED';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'social-cues:stripe-binding:' || p_stripe_environment || ':' || p_workspace_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'social-cues:stripe-customer:' || p_stripe_environment || ':' || p_stripe_customer_id,
      0
    )
  );

  select binding_row.*
  into v_binding
  from public.stripe_billing_bindings binding_row
  where binding_row.workspace_id = p_workspace_id
    and binding_row.stripe_environment = p_stripe_environment
  for update;

  if v_binding.id is null then
    select binding_row.workspace_id
    into v_existing_customer_workspace
    from public.stripe_billing_bindings binding_row
    where binding_row.stripe_environment = p_stripe_environment
      and binding_row.stripe_customer_id = p_stripe_customer_id
    for share;

    if v_existing_customer_workspace is not null
      and v_existing_customer_workspace <> p_workspace_id then
      raise exception using errcode = '23505', message = 'STRIPE_B0_CUSTOMER_ALREADY_BOUND';
    end if;

    insert into public.stripe_billing_bindings (
      workspace_id,
      stripe_environment,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_price_id,
      plan_id,
      subscription_status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      latest_event_created,
      latest_event_id
    ) values (
      p_workspace_id,
      p_stripe_environment,
      p_stripe_customer_id,
      p_stripe_subscription_id,
      p_stripe_price_id,
      p_plan_id,
      p_subscription_status,
      p_current_period_start,
      p_current_period_end,
      coalesce(p_cancel_at_period_end, false),
      p_event_created,
      p_event_id
    )
    returning * into v_binding;
    v_result_code := 'created';
  else
    if v_binding.stripe_customer_id <> p_stripe_customer_id then
      raise exception using errcode = '23514', message = 'STRIPE_B0_CUSTOMER_CHANGE_REJECTED';
    end if;

    if (p_event_created, p_event_id) <= (v_binding.latest_event_created, v_binding.latest_event_id) then
      return query select
        v_binding.id,
        v_binding.workspace_id,
        v_binding.stripe_environment,
        v_binding.plan_id,
        v_binding.subscription_status,
        v_binding.current_period_start,
        v_binding.current_period_end,
        v_binding.cancel_at_period_end,
        false,
        'replayed_or_stale'::text,
        false,
        v_binding.created_at,
        v_binding.updated_at;
      return;
    end if;

    v_subscription_replaced := v_binding.stripe_subscription_id is distinct from p_stripe_subscription_id;
    perform pg_catalog.set_config('social_cues.stripe_reconcile', 'v1', true);
    update public.stripe_billing_bindings binding_row
    set stripe_subscription_id = p_stripe_subscription_id,
        stripe_price_id = p_stripe_price_id,
        plan_id = p_plan_id,
        subscription_status = p_subscription_status,
        current_period_start = p_current_period_start,
        current_period_end = p_current_period_end,
        cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
        latest_event_created = p_event_created,
        latest_event_id = p_event_id,
        updated_at = pg_catalog.now()
    where binding_row.id = v_binding.id
    returning * into v_binding;
    perform pg_catalog.set_config('social_cues.stripe_reconcile', '', true);
    v_result_code := case
      when v_terminal then 'current_subscription_cleared'
      when v_subscription_replaced then 'current_subscription_replaced'
      else 'current_subscription_updated'
    end;
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
    null,
    'stripe.binding.reconciled',
    'stripe',
    'stripe',
    v_binding.id::text,
    pg_catalog.jsonb_build_object(
      'environment', p_stripe_environment,
      'event_id', p_event_id,
      'result_code', v_result_code,
      'subscription_status', v_binding.subscription_status,
      'plan_id', v_binding.plan_id,
      'subscription_replaced', v_subscription_replaced
    )
  );

  return query select
    v_binding.id,
    v_binding.workspace_id,
    v_binding.stripe_environment,
    v_binding.plan_id,
    v_binding.subscription_status,
    v_binding.current_period_start,
    v_binding.current_period_end,
    v_binding.cancel_at_period_end,
    true,
    v_result_code,
    v_subscription_replaced,
    v_binding.created_at,
    v_binding.updated_at;
end;
$function$;

alter function public.social_cues_reconcile_stripe_binding(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, bigint, text
) owner to postgres;
comment on function public.social_cues_reconcile_stripe_binding(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, bigint, text
) is 'social-cues:stripe-b0:v1 service-only durable customer and mutable current-subscription reconciliation';
revoke all on function public.social_cues_reconcile_stripe_binding(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, bigint, text
) from public, anon, authenticated;
grant execute on function public.social_cues_reconcile_stripe_binding(
  uuid, text, text, text, text, text, text, timestamptz, timestamptz, boolean, bigint, text
) to service_role;

create or replace function public.social_cues_claim_stripe_webhook_event(
  p_workspace_id uuid,
  p_stripe_environment text,
  p_event_id text,
  p_event_type text,
  p_stale_after_seconds integer
)
returns table (
  claimed boolean,
  duplicate boolean,
  event_status text,
  event_attempts integer,
  result_code text
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_event public.webhook_events%rowtype;
  v_database_role text;
  v_jwt_role text;
  v_ledger_event_id text;
  v_stale_interval interval;
begin
  v_database_role := nullif(pg_catalog.current_setting('role', true), 'none');
  v_jwt_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  if v_database_role is distinct from 'service_role'
    or (v_jwt_role is not null and v_jwt_role <> 'service_role') then
    raise exception using errcode = '42501', message = 'STRIPE_B0_SERVICE_ROLE_REQUIRED';
  end if;

  if p_workspace_id is null
    or p_stripe_environment not in ('test', 'live')
    or p_event_id is null
    or p_event_id !~ '^evt_[A-Za-z0-9]{6,248}$'
    or nullif(pg_catalog.btrim(coalesce(p_event_type, '')), '') is null
    or pg_catalog.length(p_event_type) > 160
    or p_stale_after_seconds is null
    or p_stale_after_seconds not between 1 and 3600 then
    raise exception using errcode = '22023', message = 'STRIPE_B0_WEBHOOK_CLAIM_INPUT_INVALID';
  end if;

  if not exists (
    select 1 from public.workspaces workspace_row
    where workspace_row.id = p_workspace_id
    for key share
  ) then
    raise exception using errcode = '23503', message = 'STRIPE_B0_WORKSPACE_REQUIRED';
  end if;

  v_ledger_event_id := p_stripe_environment || ':' || p_event_id;
  v_stale_interval := p_stale_after_seconds * interval '1 second';

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'social-cues:stripe-webhook:' || p_stripe_environment || ':' || p_event_id,
      0
    )
  );

  select event_row.*
  into v_event
  from public.webhook_events event_row
  where event_row.provider = 'stripe'
    and event_row.event_id = v_ledger_event_id
  for update;

  if v_event.id is null then
    insert into public.webhook_events (
      provider,
      event_id,
      event_type,
      status,
      attempts,
      received_at,
      processed_at,
      last_error,
      environment,
      workspace_id,
      result_code,
      processing_result
    ) values (
      'stripe',
      v_ledger_event_id,
      p_event_type,
      'processing',
      1,
      pg_catalog.now(),
      null,
      null,
      p_stripe_environment,
      p_workspace_id,
      'claimed',
      '{}'::jsonb
    ) returning * into v_event;

    return query select true, false, v_event.status, v_event.attempts, 'claimed'::text;
    return;
  end if;

  if v_event.environment is distinct from p_stripe_environment
    or v_event.workspace_id is distinct from p_workspace_id
    or v_event.event_type is distinct from p_event_type then
    raise exception using errcode = '23514', message = 'STRIPE_B0_WEBHOOK_CLAIM_CONFLICT';
  end if;

  if v_event.status = 'complete' then
    return query select false, true, v_event.status, v_event.attempts, 'already_complete'::text;
    return;
  end if;

  if v_event.status = 'processing'
    and v_event.received_at >= pg_catalog.now() - v_stale_interval then
    return query select false, true, v_event.status, v_event.attempts, 'already_claimed'::text;
    return;
  end if;

  update public.webhook_events event_row
  set event_type = p_event_type,
      status = 'processing',
      attempts = v_event.attempts + 1,
      received_at = pg_catalog.now(),
      processed_at = null,
      last_error = null,
      result_code = 'reclaimed',
      processing_result = '{}'::jsonb
  where event_row.id = v_event.id
  returning * into v_event;

  return query select true, false, v_event.status, v_event.attempts, 'reclaimed'::text;
end;
$function$;

alter function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, integer)
  owner to postgres;
comment on function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, integer) is
  'social-cues:stripe-b0:v1 service-only environment-separated idempotent webhook claim';
revoke all on function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.social_cues_claim_stripe_webhook_event(uuid, text, text, text, integer)
  to service_role;

alter table public.stripe_billing_bindings enable row level security;
alter table public.stripe_billing_bindings force row level security;
alter table public.stripe_checkout_sessions enable row level security;
alter table public.stripe_checkout_sessions force row level security;
alter table public.webhook_events enable row level security;

revoke all on table public.stripe_billing_bindings from public, anon, authenticated;
revoke all on table public.stripe_checkout_sessions from public, anon, authenticated;
grant select on table public.stripe_billing_bindings to service_role;
grant select, insert, update on table public.stripe_checkout_sessions to service_role;

do $policies$
begin
  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.stripe_billing_bindings'::regclass
      and polname = 'stripe_billing_bindings_deny_client_access'
  ) then
    create policy stripe_billing_bindings_deny_client_access
      on public.stripe_billing_bindings
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_policy
    where polrelid = 'public.stripe_checkout_sessions'::regclass
      and polname = 'stripe_checkout_sessions_deny_client_access'
  ) then
    create policy stripe_checkout_sessions_deny_client_access
      on public.stripe_checkout_sessions
      as restrictive
      for all
      to anon, authenticated
      using (false)
      with check (false);
  end if;
end;
$policies$;

do $postflight$
begin
  if pg_temp.social_cues_b0_relation_fingerprint('public.stripe_billing_bindings'::regclass)
      <> '89b16a84e4f3a463af9fe819256019e7'
    or pg_temp.social_cues_b0_relation_fingerprint('public.stripe_checkout_sessions'::regclass)
      <> 'ba0f9cb575217afb17fa5290b1454227'
    or pg_temp.social_cues_b0_function_fingerprint(
      'public.social_cues_enforce_stripe_binding_update()'::regprocedure
    ) <> 'aa501295ed151d5f6da1bc03de0f4ab6'
    or pg_temp.social_cues_b0_function_fingerprint(
      'public.social_cues_enforce_stripe_checkout_identity()'::regprocedure
    ) <> '6e4a6b739f8a0073dc3e2bc3ff0a2fb0'
    or pg_temp.social_cues_b0_function_fingerprint(
      'public.social_cues_reconcile_stripe_binding(uuid,text,text,text,text,text,text,timestamptz,timestamptz,boolean,bigint,text)'::regprocedure
    ) <> '367a228090a0e1f9b3b5d57619ae3b8e'
    or pg_temp.social_cues_b0_function_fingerprint(
      'public.social_cues_claim_stripe_webhook_event(uuid,text,text,text,integer)'::regprocedure
    ) <> '098962f257bd503e99e2dee9890dac9c'
    or not exists (
      select 1 from pg_catalog.pg_constraint con
      where con.conrelid = 'public.webhook_events'::regclass
        and con.conname = 'webhook_events_processing_result_safe_check'
        and pg_catalog.md5(pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, true), '[[:space:]]', '', 'g'
        )) = '0041cd0dbc78440abd089b4e94cb7cb3'
        and pg_catalog.obj_description(con.oid, 'pg_constraint')
          = 'social-cues:stripe-b0:v1 sanitized Stripe processing-result metadata'
    )
    or not exists (
      select 1 from pg_catalog.pg_constraint con
      where con.conrelid = 'public.webhook_events'::regclass
        and con.conname = 'webhook_events_result_code_safe_check'
        and pg_catalog.md5(pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(con.oid, true), '[[:space:]]', '', 'g'
        )) = '26cdc71d479a0481919a34e8b8b5800e'
        and pg_catalog.obj_description(con.oid, 'pg_constraint')
          = 'social-cues:stripe-b0:v1 bounded Stripe result code'
    ) then
    raise exception using errcode = '23514', message = 'STRIPE_B0_POSTFLIGHT_DEFINITION_MISMATCH';
  end if;
end;
$postflight$;

commit;
